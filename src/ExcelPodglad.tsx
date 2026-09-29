import {useEffect,useMemo,useRef,useState} from "react";
import type ExcelJS from "exceljs";
import {tekstKomorki,type Umowa} from "./rozliczenie";

// Oczekujący wpis z bieżącej faktury (jeszcze nie zapisany do Excela)
export type Oczekujacy={row:number;col:number;ilosc:number;pewne:boolean;idx:number};

const kolor=(c:ExcelJS.Cell)=>{
 const f=c.fill as {type?:string;fgColor?:{argb?:string}}|undefined;
 const a=f?.type==="pattern"?f.fgColor?.argb:undefined;
 return a&&a.length===8&&!/^FFFFFFFF$/i.test(a)?"#"+a.slice(2):undefined;
};
const pokaz=(v:ExcelJS.CellValue)=>{
 if(v instanceof Date)return v.toLocaleDateString("pl-PL");
 if(typeof v==="number")return String(Math.round(v*100)/100).replace(".",",");
 if(v&&typeof v==="object"&&("formula" in v||"sharedFormula" in v)){
  // formuła: pokazuję zapamiętany wynik (ExcelJS gubi wynik równy 0)
  const r=(v as {result?:unknown}).result;
  if(r===undefined||r===null)return "0";
  if(typeof r==="object"&&r&&"error" in r)return String((r as {error:string}).error);
  return typeof r==="number"?String(Math.round(r*100)/100).replace(".",","):String(r);
 }
 return tekstKomorki(v);
};
const LEPKIE=300; // szerokość kolumn przyklejonych (#, Lp, nazwa)
const ile=(n:number)=>String(Math.round(n*100)/100).replace(".",",");

/** Podgląd arkusza z umową: prawdziwe wartości i kolory z pliku + podgląd tego, co zostanie dopisane z bieżącej faktury. */
export default function ExcelPodglad({umowa,wersja,oczekujace,wybrany,onWybierz,onUstaw,domyslnyMiesiac}:{umowa:Umowa;wersja:number;oczekujace:Oczekujacy[];wybrany:number|null;onWybierz:(idx:number)=>void;onUstaw?:(row:number,col:number,ilosc:number)=>void;domyslnyMiesiac?:number|null}){
 const wrap=useRef<HTMLDivElement>(null);
 const [tylkoWpisy,setTylkoWpisy]=useState(false);
 // widok jednego miesiąca: nazwa + ilości + wybrany miesiąc (reszta miesięcy schowana) – czytelne w wąskim oknie
 const [miesiac,setMiesiac]=useState<number|"wszystkie">(domyslnyMiesiac??"wszystkie");
 useEffect(()=>{if(domyslnyMiesiac)setMiesiac(domyslnyMiesiac)},[domyslnyMiesiac]);
 const [edycja,setEdycja]=useState<{row:number;col:number;t:string}|null>(null);

 const {kolumny,wiersze}=useMemo(()=>{
  const ws=umowa.arkusz,h=umowa.wNaglowek,ost=umowa.wiersze.length?umowa.wiersze[umowa.wiersze.length-1].row:h;
  const doRow=Math.min(ws.rowCount,ost+3,h+1500);
  const naglowek=(col:number)=>{const t=pokaz(ws.getRow(h).getCell(col).value).trim();return t||(h>1?pokaz(ws.getRow(h-1).getCell(col).value).trim():"")};
  // wiersz z literami kolumn (A, B, C…) pod nagłówkiem pomijamy
  const literowy=(r:number)=>/^[a-z]{0,1}$/i.test(pokaz(ws.getRow(r).getCell(umowa.kolNazwa).value).trim());
  const cols:number[]=[];
  for(let c=1;c<=Math.min(ws.columnCount,80);c++){
   // miesiące zawsze; inne kolumny tylko, gdy mają jakieś dane (puste przerwy w arkuszu pomijamy)
   if(umowa.miesiace.some(m=>m.col===c)){cols.push(c);continue}
   for(let r=h+1;r<=doRow;r++)if(!literowy(r)&&pokaz(ws.getRow(r).getCell(c).value).trim()){cols.push(c);break}
  }
  // Lp i nazwa zawsze na początku (przyklejone przy przewijaniu w bok)
  const przod=[umowa.kolLp,umowa.kolNazwa].filter(c=>c&&cols.includes(c));
  const kolumny=[...przod,...cols.filter(c=>!przod.includes(c))].map(c=>({col:c,tytul:naglowek(c)||"",miesiac:umowa.miesiace.some(m=>m.col===c)}));
  const wiersze=[];
  for(let r=h+1;r<=doRow;r++){
   const row=ws.getRow(r);
   const komorki=kolumny.map(k=>{const c=row.getCell(k.col);return {t:pokaz(c.value),bg:kolor(c),notka:c.note?(typeof c.note==="string"?c.note:c.note.texts?.map(t=>t.text).join("")??""):""}});
   if(literowy(r)||komorki.every(k=>!k.t.trim()))continue; // pusty wiersz albo wiersz z literami kolumn
   wiersze.push({r,komorki});
  }
  return {kolumny,wiersze};
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[umowa,wersja]);

 const mapa=useMemo(()=>{const m=new Map<string,{ilosc:number;pewne:boolean;idx:number[]}>();
  for(const o of oczekujace){const k=o.row+":"+o.col,b=m.get(k);if(b){b.ilosc+=o.ilosc;b.pewne&&=o.pewne;b.idx.push(o.idx)}else m.set(k,{ilosc:o.ilosc,pewne:o.pewne,idx:[o.idx]})}
  return m},[oczekujace]);
 // w widoku miesiąca chowam też długi opis, żeby ilości mieściły się w wąskim oknie
 const pokazane=miesiac==="wszystkie"?kolumny.map((_,i)=>i):kolumny.flatMap((k,i)=>(!k.miesiac&&!/^opis/i.test(k.tytul))||k.col===miesiac?[i]:[]);
 const wiersz=wybrany!==null?oczekujace.find(o=>o.idx===wybrany):undefined;
 const zapisz=()=>{
  if(!edycja||!onUstaw)return;
  const v=Number(edycja.t.replace(/\s/g,"").replace(",","."));
  if(edycja.t.trim()===""||(Number.isFinite(v)&&v>=0))onUstaw(edycja.row,edycja.col,edycja.t.trim()===""?0:v);
  setEdycja(null);
 };
 const wierszeZWpisem=useMemo(()=>new Set(oczekujace.map(o=>o.row)),[oczekujace]);
 const widoczne=tylkoWpisy&&oczekujace.length?wiersze.filter(w=>wierszeZWpisem.has(w.r)):wiersze;

 // po kliknięciu pozycji w tabeli: przewiń arkusz do tego wiersza i miesiąca
 useEffect(()=>{
  const el=wrap.current;if(!el||!wiersz)return;
  const tr=el.querySelector<HTMLElement>(`tr[data-row="${wiersz.row}"]`);if(!tr)return;
  const td=tr.querySelector<HTMLElement>(`td[data-col="${wiersz.col}"]`);
  el.scrollTo({top:Math.max(0,tr.offsetTop-el.clientHeight/2),left:td?Math.max(0,td.offsetLeft-LEPKIE-(el.clientWidth-LEPKIE)/2+td.offsetWidth/2):el.scrollLeft,behavior:"smooth"});
 },[wiersz,widoczne.length]);

 const niepewne=oczekujace.filter(o=>!o.pewne).length;
 return <div className="xls">
  <div className="xls-pasek">
   <label className="xls-mies-wybor">Miesiąc:<select value={miesiac} onChange={e=>setMiesiac(e.target.value==="wszystkie"?"wszystkie":Number(e.target.value))}>
    <option value="wszystkie">wszystkie</option>{umowa.miesiace.map(m=><option key={m.col} value={m.col}>{m.etykieta}</option>)}</select></label>
   <span className="xls-leg"><i className="l-zolty"/>do sprawdzenia{niepewne?` (${niepewne})`:""}</span>
   <span className="xls-leg"><i className="l-zielony"/>pewne</span>
   <span className="xls-leg"><i className="l-plik"/>kolor z pliku</span>
   {oczekujace.length>0&&<label className="xls-filtr"><input type="checkbox" checked={tylkoWpisy} onChange={e=>setTylkoWpisy(e.target.checked)}/>tylko wiersze z tej faktury</label>}
  </div>
  <div className="xls-okno" ref={wrap}>
   <table className="xls-tab"><thead><tr><th className="xls-nr">#</th>{pokazane.map(i=>kolumny[i]).map((k,i)=><th key={k.col} className={(i<2&&(k.col===umowa.kolLp||k.col===umowa.kolNazwa)?"xls-lepki"+i:"")+(k.miesiac?" xls-mies":"")} title={k.tytul}>{k.tytul}</th>)}</tr></thead>
    <tbody>{widoczne.map(w=><tr key={w.r} data-row={w.r} className={wiersz?.row===w.r?"xls-wybrany":wierszeZWpisem.has(w.r)?"xls-zwpisem":""}>
     <td className="xls-nr">{w.r}</td>
     {pokazane.map(i=>{
      const c=w.komorki[i],k=kolumny[i],o=mapa.get(w.r+":"+k.col),lepki=i<2&&(k.col===umowa.kolLp||k.col===umowa.kolNazwa)?"xls-lepki"+i:"";
      const edytowalna=k.miesiac&&!!onUstaw,teraz=edycja&&edycja.row===w.r&&edycja.col===k.col;
      const cls=[lepki,o?(o.pewne?"xls-nowy-ok":"xls-nowy-uwaga"):"",o&&wiersz?.row===w.r&&wiersz.col===k.col?"xls-cel":"",c.notka?"xls-notka":"",edytowalna?"xls-edyt":""].join(" ");
      return <td key={k.col} data-col={k.col} className={cls} style={!o&&c.bg?{background:c.bg}:undefined}
        title={[o?`Z tej faktury: +${ile(o.ilosc)}${o.pewne?"":" (do sprawdzenia)"}`:"",c.notka].filter(Boolean).join("\n")||(i===1?c.t:undefined)}
        onClick={()=>{if(o)onWybierz(o.idx[0]);if(edytowalna&&!teraz)setEdycja({row:w.r,col:k.col,t:o?ile(o.ilosc):""})}}>
       {teraz?<span className="xls-wpis"><span className="xls-bylo">{c.t}</span>+<input autoFocus inputMode="decimal" value={edycja!.t} placeholder="ile" onChange={e=>setEdycja({...edycja!,t:e.target.value})}
          onKeyDown={e=>{if(e.key==="Enter")zapisz();if(e.key==="Escape")setEdycja(null)}} onBlur={zapisz} onClick={e=>e.stopPropagation()}/></span>
        :o?<><span className="xls-bylo">{c.t}</span><b>+{ile(o.ilosc)}</b></>:c.t}
      </td>})}
    </tr>)}</tbody></table>
  </div>
  <div className="podglad-pomoc">Kliknij komórkę miesiąca, aby wpisać lub poprawić ilość do dopisania (Enter – zatwierdź, Esc – anuluj). „+ilość” to wpis jeszcze nie zapisany do pliku – zapisuje go przycisk „Wpisz do Excela”.</div>
 </div>;
}
