"use client";
import {useEffect,useMemo,useRef,useState} from "react";
import {FileImage,FileText,LoaderCircle,Plus,ScanText,Trash2,Download,ShieldCheck} from "lucide-react";
type Row={id:string;lp:number;name:string;quantity:string;unit:string};
const demoRows:Row[]=[
 {id:"a",lp:1,name:"T-REX KLEJ GOLD HYBRYDOWY 290 ml – SOUDAL",quantity:"2",unit:"szt."},
 {id:"b",lp:2,name:"WAŁEK MIKROFIBRA ZAPAS 25 cm – BlueDolphin",quantity:"5",unit:"szt."}
];
const id=()=>crypto.randomUUID();
function parseText(text:string){
 const ignored=/^(lp\.?|nazwa|towar|usług|ilość|miara|j\.?m\.?|vat|netto|brutto|cena|wartość)/i;
 const rows:Row[]=[];
 for(const raw of text.split(/\n+/).map(x=>x.replace(/\s+/g," ").trim()).filter(Boolean)){
  if(ignored.test(raw)||raw.length<4)continue;
  const line=raw.replace(/^[|\s[(]*(\d{1,3})[.)|\]/\\-]*\s*/,"");
  // Pierwsza para „liczba + jednostka” wyznacza kolumny Ilość i Jedn.m.
  // Tekst po jednostce (ceny, VAT, wartości) jest ignorowany.
  const m=line.match(/^(.*?)\s+(\d+(?:[,.]\d+)?)\s+(szt\.?|mb\.?|m2|m²|m3|m³|kg\.?|g\.?|l\.?|ml\.?|opak\.?|kpl\.?|usł\.?|godz\.?)(?:[|)\],.;:]|\s|$)/i);
  if(m){
   // Usuń końcowy symbol PKWiU, także gdy OCR poprzedził go literą lub kreską.
   const name=m[1].replace(/\s+[a-z|]?\d{1,2}(?:[.:-]\d{1,2}){2,}(?:[.:-]\d{1,2})*\s*$/i,"").replace(/[|[]+$/,"").trim();
   if(name.length>2)rows.push({id:id(),lp:rows.length+1,name,quantity:m[2],unit:m[3].replace(/[,;|)]$/,"")});
  }
 }
 return rows;
}
export default function Home(){
 const input=useRef<HTMLInputElement>(null);
 const [rows,setRows]=useState<Row[]>(demoRows),[fileName,setFileName]=useState(""),[busy,setBusy]=useState(false),[progress,setProgress]=useState(0),[message,setMessage]=useState("Wczytaj fakturę, aby rozpocząć");
 useEffect(()=>{if("serviceWorker"in navigator)navigator.serviceWorker.register("/sw.js").catch(()=>undefined)},[]);
 const count=useMemo(()=>rows.filter(r=>r.name.trim()&&r.quantity.trim()).length,[rows]);
 const update=(rowId:string,field:"name"|"quantity"|"unit",value:string)=>setRows(a=>a.map(r=>r.id===rowId?{...r,[field]:value}:r));
 const remove=(rowId:string)=>setRows(a=>a.filter(r=>r.id!==rowId).map((r,i)=>({...r,lp:i+1})));
 async function images(file:File){
  if(!file.type.includes("pdf"))return[URL.createObjectURL(file)];
  const pdfjs=await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc=new URL("pdfjs-dist/build/pdf.worker.min.mjs",import.meta.url).toString();
  const pdf=await pdfjs.getDocument({data:await file.arrayBuffer()}).promise,out:string[]=[];
  for(let n=1;n<=pdf.numPages;n++){const page=await pdf.getPage(n),view=page.getViewport({scale:2}),canvas=document.createElement("canvas");canvas.width=view.width;canvas.height=view.height;await page.render({canvas,canvasContext:canvas.getContext("2d")!,viewport:view}).promise;out.push(canvas.toDataURL("image/jpeg",.92))}
  return out;
 }
 async function read(file:File){
  setBusy(true);setProgress(4);setFileName(file.name);setMessage("Przygotowuję dokument…");
  try{
   const pages=await images(file),module=await import("tesseract.js"),T=module.default;let text="";
   for(let i=0;i<pages.length;i++){const result=await T.recognize(pages[i],"pol+eng",{logger:e=>{if(e.status==="recognizing text"){setProgress(Math.round(((i+e.progress)/pages.length)*100));setMessage(`Odczytuję stronę ${i+1} z ${pages.length}…`)}}});text+="\n"+result.data.text}
   const found=parseText(text);setRows(found);setProgress(100);setMessage(found.length?`Rozpoznano ${found.length} pozycji. Sprawdź dane.`:"Nie rozpoznano tabeli. Dodaj pozycje ręcznie lub użyj wyraźniejszego skanu.");
  }catch(e){console.error(e);setMessage("Nie udało się odczytać dokumentu. Spróbuj wyraźniejszego zdjęcia lub PDF.")}finally{setBusy(false)}
 }
 async function exportPdf(){
  const pdfMakeModule=await import("pdfmake/build/pdfmake");
  const fontsModule=await import("pdfmake/build/vfs_fonts");
  const pdfMake=pdfMakeModule.default;
  pdfMake.vfs=fontsModule.default;
  const body=[
   [{text:"Lp.",bold:true},{text:"Nazwa towaru lub usługi",bold:true},{text:"Ilość",bold:true},{text:"Jedn.m",bold:true}],
   ...rows.filter(r=>r.name.trim()).map((r,index)=>[String(index+1),r.name,r.quantity,r.unit])
  ];
  pdfMake.createPdf({
   pageSize:"A4",pageMargins:[36,42,36,42],
   content:[
    {text:"ZESTAWIENIE TOWARÓW I USŁUG",fontSize:15,bold:true,margin:[0,0,0,6]},
    {text:`Źródło: ${fileName||"dane wprowadzone ręcznie"}`,fontSize:9,color:"#526174",margin:[0,0,0,14]},
    {table:{headerRows:1,widths:[28,"*",45,48],body},layout:{fillColor:(row:number)=>row===0?"#ebeff4":null}}
   ],
   defaultStyle:{font:"Roboto",fontSize:9}
  }).download(`zestawienie-${new Date().toISOString().slice(0,10)}.pdf`);
 }
 return <main className="app-shell">
  <header className="topbar"><div className="brand-mark"><ScanText size={25}/></div><div><h1>Faktura → Zestawienie</h1><p>Odczyt pozycji z JPG i PDF</p></div><div className="privacy"><ShieldCheck size={18}/><span>Dane przetwarzane na tym urządzeniu</span></div></header>
  <section className="workspace">
   <aside className="upload-card"><div className="step">KROK 1</div><h2>Wczytaj fakturę</h2>
    <button className="dropzone" onClick={()=>input.current?.click()} disabled={busy}>{fileName?<FileText size={34}/>:<FileImage size={34}/>}<strong>{fileName||"Wybierz JPG lub PDF"}</strong><span>{fileName?"Kliknij, aby zmienić dokument":"Wyraźny skan daje najlepszy wynik"}</span></button>
    <input ref={input} hidden type="file" accept="image/jpeg,image/png,application/pdf" onChange={e=>e.target.files?.[0]&&read(e.target.files[0])}/>
    <div className="status"><div>{busy&&<LoaderCircle className="spin" size={18}/>}<span>{message}</span></div>{(busy||progress>0)&&<div className="progress"><i style={{width:`${progress}%`}}/></div>}</div>
    <div className="tip"><strong>Ważne</strong><p>Po rozpoznaniu sprawdź nazwy i ilości. Program daje etap kontroli przed utworzeniem PDF.</p></div>
   </aside>
   <section className="table-card"><div className="table-heading"><div><span className="step">KROK 2</span><h2>Sprawdź rozpoznane pozycje</h2></div><span className="count">{count} pozycji</span></div>
    <div className="table-wrap"><table><thead><tr><th>Lp.</th><th>Nazwa towaru lub usługi</th><th>Ilość</th><th>Jedn.m</th><th aria-label="Usuń"/></tr></thead><tbody>
     {rows.length?rows.map(r=><tr key={r.id}><td>{r.lp}</td><td><input value={r.name} onChange={e=>update(r.id,"name",e.target.value)} aria-label={`Nazwa pozycji ${r.lp}`}/></td><td><input className="short" value={r.quantity} onChange={e=>update(r.id,"quantity",e.target.value)} aria-label={`Ilość pozycji ${r.lp}`}/></td><td><input className="short" value={r.unit} onChange={e=>update(r.id,"unit",e.target.value)} aria-label={`Miara pozycji ${r.lp}`}/></td><td><button className="icon-btn" onClick={()=>remove(r.id)} aria-label={`Usuń pozycję ${r.lp}`}><Trash2 size={17}/></button></td></tr>):<tr><td colSpan={5} className="empty">Brak pozycji. Wczytaj dokument lub dodaj pusty wiersz.</td></tr>}
    </tbody></table></div>
    <div className="actions"><button className="secondary" onClick={()=>setRows(a=>[...a,{id:id(),lp:a.length+1,name:"",quantity:"1",unit:"szt."}])}><Plus size={18}/>Dodaj pozycję</button><button className="primary" onClick={exportPdf} disabled={!count}><Download size={18}/>Utwórz PDF</button></div>
   </section>
  </section><footer>Po wygenerowaniu pliku możesz go wydrukować albo zapisać w dokumentacji.</footer>
 </main>
}
