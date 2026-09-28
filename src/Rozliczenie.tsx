import {useEffect,useMemo,useRef,useState} from "react";
import {FileSpreadsheet,FileText,LoaderCircle,Download,Check,TriangleAlert,RotateCcw,Plus} from "lucide-react";
import type {Worker as TWorker} from "tesseract.js";
import Podglad,{type Strona,type Zaznaczenie,type Znacznik} from "./Podglad";
import ExcelPodglad,{type Oczekujacy} from "./ExcelPodglad";
import {czytajFakture,opcjeTesseract} from "./odczyt";
import {wczytajUmowe,przypisz,numerIData,wpisz,doPliku,juzDodana,skrot,zl,miesiacDla,type Umowa,type Przypisanie} from "./rozliczenie";

// ---- przechowanie Excela w przeglądarce (żeby odświeżenie strony nie kasowało pracy)
const DB="rozliczenie",ST="pliki";
function idb():Promise<IDBDatabase>{return new Promise((ok,err)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore(ST);r.onsuccess=()=>ok(r.result);r.onerror=()=>err(r.error)})}
async function zapiszLokalnie(nazwa:string,dane:ArrayBuffer){try{const d=await idb();await new Promise((ok,err)=>{const t=d.transaction(ST,"readwrite");t.objectStore(ST).put({nazwa,dane,kiedy:Date.now()},"umowa");t.oncomplete=ok;t.onerror=()=>err(t.error)})}catch{/* brak miejsca / tryb prywatny */}}
async function wczytajLokalnie():Promise<{nazwa:string;dane:ArrayBuffer;kiedy:number}|null>{try{const d=await idb();return await new Promise(ok=>{const r=d.transaction(ST).objectStore(ST).get("umowa");r.onsuccess=()=>ok(r.result||null);r.onerror=()=>ok(null)})}catch{return null}}
async function usunLokalnie(){try{const d=await idb();d.transaction(ST,"readwrite").objectStore(ST).delete("umowa")}catch{/* nic */}}

const dataIso=(d:Date|null)=>d?d.toISOString().slice(0,10):"";
const pobierz=(blob:Blob,nazwa:string)=>{const u=URL.createObjectURL(blob),a=document.createElement("a");a.href=u;a.download=nazwa;a.click();setTimeout(()=>URL.revokeObjectURL(u),1500)};

type Faktura={plik:string;klucz:string;numer:string;data:Date|null;przypisania:Przypisanie[];podglady:Strona[];duplikat:string|null};

export default function Rozliczenie(){
 const inExcel=useRef<HTMLInputElement>(null),inFaktura=useRef<HTMLInputElement>(null);
 const [umowa,setUmowa]=useState<Umowa|null>(null),[wersja,setWersja]=useState(0);
 const [faktura,setFaktura]=useState<Faktura|null>(null);
 const [busy,setBusy]=useState(false),[postep,setPostep]=useState(0),[msg,setMsg]=useState("Wczytaj Excel z formularzem cenowym (umową).");
 const [historia,setHistoria]=useState<string[]>([]),[zmiany,setZmiany]=useState(false),[wybrany,setWybrany]=useState<number|null>(null);
 const [widok,setWidok]=useState<"oba"|"faktura"|"excel">("oba");

 useEffect(()=>{(async()=>{const z=await wczytajLokalnie();if(!z)return;try{const u=await wczytajUmowe(z.dane,z.nazwa);setUmowa(u);setMsg(`Przywrócono „${z.nazwa}” z ${new Date(z.kiedy).toLocaleString("pl-PL")}. Możesz dodawać kolejne faktury.`)}catch{/* stary zapis */}})()},[]);

 async function excel(f:File){
  setBusy(true);setMsg("Czytam Excel…");
  try{const dane=await f.arrayBuffer();const u=await wczytajUmowe(dane,f.name);setUmowa(u);setFaktura(null);setHistoria([]);setZmiany(false);await zapiszLokalnie(f.name,dane);
   setMsg(`Wczytano „${f.name}”: ${u.wiersze.length} pozycji, miesiące ${u.miesiace[0].etykieta} – ${u.miesiace[u.miesiace.length-1].etykieta}. Teraz dodaj fakturę.`)}
  catch(e){setMsg(e instanceof Error?e.message:"Nie udało się otworzyć pliku Excel.")}finally{setBusy(false);if(inExcel.current)inExcel.current.value=""}
 }

 async function fakturaPlik(f:File){
  if(!umowa)return;
  setBusy(true);setPostep(3);setMsg("Czytam fakturę…");
  let worker:TWorker|null=null;
  const dajWorker=async()=>{if(worker)return worker;setMsg("Ładuję moduł rozpoznawania tekstu…");const T=(await import("tesseract.js")).default;worker=await T.createWorker(["pol","eng"],T.OEM.LSTM_ONLY,opcjeTesseract());await worker.setParameters({preserve_interword_spaces:"1",user_defined_dpi:"300"});return worker};
  try{
   faktura?.podglady.forEach(p=>URL.revokeObjectURL(p.src));
   const dane=await f.arrayBuffer(),klucz=await skrot(dane);
   const w=await czytajFakture(f,(p,o)=>{setPostep(p);setMsg(o)},dajWorker);
   if((globalThis as {__ocrDebug?:boolean}).__ocrDebug)console.log("TEKST FAKTURY:",w.tekst);
   const {numer,data}=numerIData(w.tekst,umowa);
   const przypisania=przypisz(w.pozycje,umowa,data);
   const fk:Faktura={plik:f.name,klucz,numer,data,przypisania,podglady:w.podglady,duplikat:null};
   fk.duplikat=juzDodana(umowa,{numer,data,plik:f.name,klucz});
   setFaktura(fk);setWybrany(null);setPostep(100);
   const niep=przypisania.filter(p=>p.wlacz&&!p.pewne).length,brak=przypisania.filter(p=>!p.wlacz).length;
   setMsg(!w.pozycje.length?"Nie odczytałem pozycji z tej faktury. Spróbuj wyraźniejszego skanu/zdjęcia.":
    `Odczytano ${w.pozycje.length} pozycji.`+(niep?` ${niep} do sprawdzenia (żółte).`:"")+(brak?` ${brak} nie ma w umowie.`:"")+(data?"":" Nie odczytałem daty – wybierz miesiąc."));
  }catch(e){console.error(e);setMsg(e instanceof Error?e.message:"Nie udało się odczytać faktury.")}
  finally{setBusy(false);if(worker)await (worker as TWorker).terminate();if(inFaktura.current)inFaktura.current.value=""}
 }

 const zmien=(i:number,z:Partial<Przypisanie>)=>setFaktura(f=>f&&{...f,przypisania:f.przypisania.map((p,j)=>j===i?{...p,...z}:p)});
 function ustawDate(v:string){
  if(!faktura||!umowa)return;
  const d=v?new Date(v+"T00:00:00Z"):null,m=miesiacDla(d,umowa);
  setFaktura({...faktura,data:d,przypisania:faktura.przypisania.map(p=>({...p,col:m?.col??p.col}))});
 }

 async function zatwierdz(){
  if(!umowa||!faktura)return;
  const bez=faktura.przypisania.filter(p=>p.wlacz&&(!p.row||!p.col));
  if(bez.length){setMsg(`Uzupełnij pozycję w umowie i miesiąc dla ${bez.length} zaznaczonych wierszy (albo je odznacz).`);return}
  if(faktura.duplikat&&!window.confirm(faktura.duplikat+"\n\nDopisać mimo to?"))return;
  setBusy(true);setMsg("Zapisuję do Excela…");
  let r:{dane:ArrayBuffer;wpisano:number;zolte:number};
  try{
   r=await wpisz(umowa,faktura.przypisania,{numer:faktura.numer,data:faktura.data,plik:faktura.plik,klucz:faktura.klucz});
   const nowa=await wczytajUmowe(r.dane,umowa.nazwaPliku);setUmowa(nowa);await zapiszLokalnie(umowa.nazwaPliku,r.dane);
  }catch(e){console.error(e);setMsg(e instanceof Error?"Nie udało się zapisać: "+e.message:"Nie udało się zapisać do Excela.");return}
  finally{setBusy(false)}
  setHistoria(h=>[...h,`${faktura.numer||faktura.plik}: ${r.wpisano} poz.`+(r.zolte?` (${r.zolte} na żółto)`:"")]);
  setZmiany(true);setWersja(v=>v+1);
  faktura.podglady.forEach(p=>URL.revokeObjectURL(p.src));setFaktura(null);
  setMsg(`Wpisano ${r.wpisano} pozycji do Excela`+(r.zolte?`, ${r.zolte} zaznaczono na żółto do sprawdzenia`:"")+". Dodaj kolejną fakturę albo pobierz Excel.");
 }

 async function pobierzExcel(){
  if(!umowa)return;
  const nazwa=umowa.nazwaPliku.replace(/\.xlsx?$/i,"")+`-uzupelniony-${new Date().toISOString().slice(0,10)}.xlsx`;
  pobierz(await doPliku(umowa),nazwa);setZmiany(false);
 }
 async function odNowa(){
  if(zmiany&&!window.confirm("Masz wpisane faktury, a Excel nie został pobrany. Zacząć od nowa?"))return;
  await usunLokalnie();setUmowa(null);setFaktura(null);setHistoria([]);setZmiany(false);setMsg("Wczytaj Excel z formularzem cenowym (umową).");
 }

 const opcjeWierszy=useMemo(()=>umowa?umowa.wiersze.map(w=>({row:w.row,opis:`${w.lp?w.lp+". ":""}${w.nazwa.slice(0,70)}${w.opis?" – "+w.opis.slice(0,40):""} · ${w.cena!==null?zl(w.cena):"brak ceny"}`})):[],[umowa,wersja]);
 const stan=(p:Przypisanie)=>{const w=umowa?.wiersze.find(x=>x.row===p.row);const zostalo=w&&w.ilosc!==null?w.ilosc-w.wykorzystano:null;const przekroczy=zostalo!==null&&p.wlacz&&p.ilosc>zostalo;return {w,zostalo,przekroczy,zolty:p.wlacz&&(!p.pewne||przekroczy)}};
 const znaczniki:Znacznik[]=useMemo(()=>faktura?faktura.przypisania.flatMap((p,i)=>stan(p).zolty&&p.poz.strona!==undefined&&p.poz.y!==undefined?[{id:i,strona:p.poz.strona,y:p.poz.y,wys:p.poz.wys||0.02,kat:p.poz.kat}]:[]):[],
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [faktura,umowa,wersja]);
 const oczekujace:Oczekujacy[]=useMemo(()=>faktura?faktura.przypisania.flatMap((p,i)=>p.wlacz&&p.row&&p.col&&p.ilosc?[{row:p.row,col:p.col,ilosc:p.ilosc,pewne:!stan(p).zolty,idx:i}]:[]):[],
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [faktura,umowa,wersja]);
 const wybierz=(i:number)=>{setWybrany(i);document.querySelector(`tr[data-poz="${i}"]`)?.scrollIntoView({block:"nearest",behavior:"smooth"})};
 const maFakture=!!faktura?.podglady.length;
 const pokazFakture=maFakture&&widok!=="excel",pokazExcel=!!umowa&&(widok!=="faktura"||!maFakture);
 const zazn:Zaznaczenie=useMemo(()=>{const p=wybrany!==null?faktura?.przypisania[wybrany]?.poz:null;return p&&p.strona!==undefined&&p.y!==undefined?{strona:p.strona,y:p.y,wys:p.wys||0.02,kat:p.kat}:null},[wybrany,faktura]);

 return <section className={"workspace"+(umowa?" z-podgladem":"")+(umowa&&!faktura?" bez-faktury":"")}>
  <aside className="upload-card">
   <div className="step">KROK 1</div><h2>Excel z umową</h2>
   <button className="dropzone maly-drop" onClick={()=>inExcel.current?.click()} disabled={busy}><FileSpreadsheet size={30}/><strong>{umowa?umowa.nazwaPliku:"Wybierz plik .xlsx"}</strong><span>{umowa?`${umowa.wiersze.length} pozycji · ${umowa.miesiace.length} miesięcy`:"formularz cenowy z kolumnami miesięcy"}</span></button>
   <input ref={inExcel} hidden type="file" accept=".xlsx,.xlsm" onChange={e=>e.target.files?.[0]&&excel(e.target.files[0])}/>
   {umowa&&<>
    <div className="step krok2">KROK 2</div><h2>Dodaj fakturę</h2>
    <button className="dropzone maly-drop" onClick={()=>inFaktura.current?.click()} disabled={busy}><FileText size={30}/><strong>{faktura?faktura.plik:"PDF, skan, zdjęcie lub Word"}</strong><span>{faktura?"kliknij, aby wybrać inną":"program odczyta pozycje i ceny netto"}</span></button>
    <input ref={inFaktura} hidden type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png,.docx,.doc" onChange={e=>e.target.files?.[0]&&fakturaPlik(e.target.files[0])}/>
   </>}
   <div className="status"><div>{busy&&<LoaderCircle className="spin" size={18}/>}<span>{msg}</span></div>{busy&&<div className="progress"><i style={{width:`${postep}%`}}/></div>}</div>
   {umowa&&<div className="rozl-akcje">
    <button className="primary szeroki" onClick={pobierzExcel} disabled={!historia.length&&!zmiany}><Download size={18}/>Pobierz uzupełniony Excel</button>
    <button className="secondary szeroki" onClick={odNowa}><RotateCcw size={16}/>Zacznij od nowa</button>
   </div>}
   {historia.length>0&&<div className="tip"><strong>Dodane w tej sesji</strong>{historia.map((h,i)=><p key={i}>✔ {h}</p>)}</div>}
   <div className="tip szary-tip"><strong>Jak to działa</strong><p>Program szuka każdej pozycji faktury w umowie po nazwie i cenie netto. Ilość dopisuje w kolumnie miesiąca z daty wystawienia faktury (dodaje do tego, co już jest). Niepewne wpisy są w Excelu na żółto, z notatką w komórce. Każda faktura trafia do arkusza „_REJESTR_FAKTUR”, więc program ostrzeże przed dodaniem jej drugi raz. Plik zostaje na tym komputerze.</p></div>
  </aside>

  <section className="table-card">
   <div className="table-heading"><div><span className="step">KROK 3</span><h2>Sprawdź dopasowanie</h2></div>
    {faktura&&<div className="faktura-meta">
     <label>Nr faktury<input value={faktura.numer} onChange={e=>setFaktura({...faktura,numer:e.target.value})} placeholder="nie odczytano"/></label>
     <label>Data wystawienia<input type="date" value={dataIso(faktura.data)} onChange={e=>ustawDate(e.target.value)}/></label>
    </div>}
   </div>
   {faktura?.duplikat&&<div className="ostrzezenie"><TriangleAlert size={18}/>{faktura.duplikat}</div>}
   <div className="table-wrap"><table className="rozl"><thead><tr><th/><th>Z faktury</th><th>Pozycja w umowie</th><th>Miesiąc</th><th>Ilość</th><th>Status</th></tr></thead><tbody>
    {!faktura?<tr><td colSpan={6} className="empty">{umowa?"Dodaj fakturę – tu pojawią się jej pozycje dopasowane do umowy.":"Najpierw wczytaj Excel z umową."}</td></tr>:
     faktura.przypisania.map((p,i)=>{
      const {w,zostalo,przekroczy,zolty}=stan(p);
      return <tr key={i} data-poz={i} className={[zolty?"uwaga":"",!p.wlacz?"wylaczony":"",wybrany===i?"wybrany":""].join(" ")} onClick={()=>setWybrany(i)}>
       <td><input type="checkbox" checked={p.wlacz} onChange={e=>zmien(i,{wlacz:e.target.checked})} aria-label="Wpisz tę pozycję"/></td>
       <td className="z-faktury"><b>{p.poz.name||"—"}</b><small>{p.poz.quantity} {p.poz.unit} · netto {p.poz.cenaNetto!==undefined?zl(p.poz.cenaNetto):"?"}{p.poz.cenaWyliczona?" (wyliczona)":""}</small></td>
       <td><select value={p.row??""} onChange={e=>{const row=e.target.value?Number(e.target.value):null;const k=p.kandydaci.find(k=>k.wiersz.row===row);zmien(i,{row,wlacz:!!row,pewne:!!row&&!!k?.cenaZgodna,powod:row?(k?.cenaZgodna?"":"Wybrane ręcznie – cena inna niż w umowie"):""})}}>
         <option value="">— nie wpisuj / wybierz —</option>
         {p.kandydaci.length>0&&<optgroup label="Najbardziej podobne">{p.kandydaci.map(k=><option key={"k"+k.wiersz.row} value={k.wiersz.row}>{k.cenaZgodna?"✓ ":""}{k.wiersz.lp}. {k.wiersz.nazwa.slice(0,60)} · {k.wiersz.cena!==null?zl(k.wiersz.cena):"?"}</option>)}</optgroup>}
         <optgroup label="Wszystkie pozycje umowy">{opcjeWierszy.map(o=><option key={o.row} value={o.row}>{o.opis}</option>)}</optgroup>
        </select>
        {w&&<small className="szary">w umowie {w.cena!==null?zl(w.cena):"brak ceny"} · {w.jm} · zostało {zostalo??"?"}{przekroczy?<b className="czerwony"> – przekroczy ilość z umowy!</b>:null}</small>}</td>
       <td><select value={p.col??""} onChange={e=>zmien(i,{col:e.target.value?Number(e.target.value):null})}><option value="">—</option>{umowa!.miesiace.map(m=><option key={m.col} value={m.col}>{m.etykieta}</option>)}</select></td>
       <td><input className="short" value={String(p.ilosc).replace(".",",")} onChange={e=>zmien(i,{ilosc:Number(e.target.value.replace(",","."))||0})}/></td>
       <td className="status-kol">{!p.wlacz?<span className="szary">pominięta</span>:zolty?<><span className="znak-uwaga"><TriangleAlert size={14}/>{przekroczy?"Przekroczy ilość z umowy":p.powod||"Do sprawdzenia"}</span>{!p.pewne&&<button className="link" onClick={e=>{e.stopPropagation();zmien(i,{pewne:true,powod:""})}}><Check size={13}/>Sprawdzone</button>}</>:<span className="ok"><Check size={14}/>pewne</span>}</td>
      </tr>})}
   </tbody></table></div>
   {faktura&&<div className="actions"><div className="action-group"><button className="secondary" onClick={()=>{faktura.podglady.forEach(p=>URL.revokeObjectURL(p.src));setFaktura(null)}}>Anuluj tę fakturę</button></div>
    <div className="export-group"><button className="primary" onClick={zatwierdz} disabled={!faktura.przypisania.some(p=>p.wlacz)}><Plus size={18}/>Wpisz do Excela ({faktura.przypisania.filter(p=>p.wlacz).length})</button></div></div>}
  </section>
  {umowa&&<aside className="preview-card">
   <div className="preview-heading podglad-zakladki"><span className="step">PODGLĄD</span>
    {maFakture?<div className="przelacznik">
     <button className={widok==="oba"?"aktywna":""} onClick={()=>setWidok("oba")}>Faktura + Excel</button>
     <button className={widok==="faktura"?"aktywna":""} onClick={()=>setWidok("faktura")}>Faktura</button>
     <button className={widok==="excel"?"aktywna":""} onClick={()=>setWidok("excel")}>Excel</button>
    </div>:<h2>Excel</h2>}
   </div>
   <div className={"podglad-dzielony"+(pokazFakture&&pokazExcel?" oba":"")}>
    {pokazFakture&&<div className="czesc"><Podglad strony={faktura!.podglady} zaznacz={zazn} znaczniki={znaczniki} onZnacznik={wybierz}/></div>}
    {pokazExcel&&<div className="czesc"><ExcelPodglad umowa={umowa} wersja={wersja} oczekujace={oczekujace} wybrany={wybrany} onWybierz={wybierz}/></div>}
   </div>
  </aside>}
 </section>;
}
