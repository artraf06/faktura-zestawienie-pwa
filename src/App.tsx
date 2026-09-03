"use client";
import {useEffect,useMemo,useRef,useState} from "react";
import {FileImage,FileText,LoaderCircle,Plus,ScanText,Trash2,Download,ShieldCheck} from "lucide-react";
type Row={id:string;lp:number;name:string;quantity:string;unit:string};
const id=()=>crypto.randomUUID();
async function prepareForOcr(source:string){
 return new Promise<string>((resolve,reject)=>{
  const image=new Image();
  image.onload=()=>{
   const top=Math.round(image.height*.27),sourceHeight=Math.round(image.height*.70);
   const targetWidth=Math.max(2400,image.width*2),scale=targetWidth/image.width;
   const canvas=document.createElement("canvas");
   canvas.width=Math.round(image.width*scale);canvas.height=Math.round(sourceHeight*scale);
   const ctx=canvas.getContext("2d",{willReadFrequently:true})!;
   ctx.drawImage(image,0,top,image.width,sourceHeight,0,0,canvas.width,canvas.height);
   const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
   for(let i=0;i<pixels.data.length;i+=4){
    const gray=.299*pixels.data[i]+.587*pixels.data[i+1]+.114*pixels.data[i+2];
    const value=Math.max(0,Math.min(255,(gray-128)*1.55+128));
    pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=value;
   }
   ctx.putImageData(pixels,0,0);resolve(canvas.toDataURL("image/png"));
  };
  image.onerror=reject;image.src=source;
 });
}
async function prepareNameColumn(source:string){
 return new Promise<string>((resolve,reject)=>{
  const image=new Image();
  image.onload=()=>{
   const left=Math.round(image.width*.045),top=Math.round(image.height*.32);
   const sourceWidth=Math.round(image.width*.43),sourceHeight=Math.round(image.height*.64);
   const scale=Math.max(2.5,1800/sourceWidth),canvas=document.createElement("canvas");
   canvas.width=Math.round(sourceWidth*scale);canvas.height=Math.round(sourceHeight*scale);
   const ctx=canvas.getContext("2d",{willReadFrequently:true})!;
   ctx.drawImage(image,left,top,sourceWidth,sourceHeight,0,0,canvas.width,canvas.height);
   const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
   for(let i=0;i<pixels.data.length;i+=4){
    const gray=.299*pixels.data[i]+.587*pixels.data[i+1]+.114*pixels.data[i+2];
    const value=Math.max(0,Math.min(255,(gray-128)*1.7+128));
    pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=value;
   }
   ctx.putImageData(pixels,0,0);resolve(canvas.toDataURL("image/png"));
  };
  image.onerror=reject;image.src=source;
 });
}
function parseNames(text:string){
 const names=new Map<number,string>();let lastLp=0;
 for(const raw of text.split(/\n+/).map(v=>v.replace(/\s+/g," ").trim()).filter(Boolean)){
  if(/^(lp\.?|nazwa towaru|nr konta)/i.test(raw))continue;
  let match=raw.match(/^[|\[({\s-]*(\d{1,3})[|.)\]}\s-]*(.{3,})$/i);
  if(!match){const damaged=raw.match(/^[SQOIl|]([0-9]{1,2})[I|.)\]}\s-]*(.{3,})$/i);if(damaged)match=[damaged[0],damaged[1],damaged[2]]}
  if(match){
   const lp=Number(match[1]);if(!lp||lp>999)continue;
   const name=match[2].replace(/\s+\d+(?:[.,-]\d+){2,}.*$/," ").replace(/[|]+$/," ").trim();
   if(name.length>2){names.set(lp,name);lastLp=lp}
  }else if(lastLp&&raw.length>3&&!/\b(szt|kpl|mb|netto|brutto|vat)\b/i.test(raw)){
   names.set(lastLp,`${names.get(lastLp)||""} ${raw.replace(/[|]+$/," ").trim()}`.trim());
  }
 }
 return names;
}
function parseText(text:string){
 const ignored=/^(lp\.?|nazwa|towar|usług|ilość|miara|j\.?m\.?|vat|netto|brutto|cena|wartość)/i;
 const rows:Row[]=[];
 for(const raw of text.split(/\n+/).map(x=>x.replace(/\s+/g," ").trim()).filter(Boolean)){
  if(ignored.test(raw)||raw.length<4)continue;
  const lpMatch=raw.match(/^[|\s[(]*(\d{1,3})[.)|\]/\\-]*\s*/);
  if(!lpMatch)continue;
  const line=raw.replace(/^[|\s[(]*(\d{1,3})[.)|\]/\\-]*\s*/,"");
  // Pierwsza para „liczba + jednostka” wyznacza kolumny Ilość i Jedn.m.
  // Tekst po jednostce (ceny, VAT, wartości) jest ignorowany.
  const m=line.match(/^(.*?)\s+(\d+(?:[,.]\d+)?)\s+(szt\.?|mb\.?|m2|m²|m3|m³|kg\.?|g\.?|l\.?|ml\.?|opak\.?|kpl\.?|usł\.?|godz\.?)(?:[|)\],.;:]|\s|$)/i);
  if(m){
   // Usuń końcowy symbol PKWiU, także gdy OCR poprzedził go literą lub kreską.
   const name=m[1].replace(/\s+[a-z|]?\d{1,2}(?:[.:-]\d{1,2}){2,}(?:[.:-]\d{1,2})*\s*$/i,"").replace(/[|[]+$/,"").trim();
   if(name.length>2)rows.push({id:id(),lp:Number(lpMatch[1]),name,quantity:m[2],unit:m[3].replace(/[,;|)]$/,"")});
  }
 }
 return rows;
}
function sequenceRows(tableRows:Row[],names:Map<number,string>){
 const byLp=new Map<number,Row>();
 for(const row of tableRows)if(row.lp>0&&row.lp<1000&&!byLp.has(row.lp))byLp.set(row.lp,row);
 const positions=[...byLp.keys(),...names.keys()].filter(v=>v>0&&v<1000);
 if(!positions.length)return tableRows.map((row,index)=>({...row,lp:index+1}));
 const last=Math.max(...positions);
 if(last>300)return tableRows.map((row,index)=>({...row,lp:index+1}));
 const ordered:Row[]=[];
 for(let lp=1;lp<=last;lp++){
  const source=byLp.get(lp),name=names.get(lp)||source?.name||"";
  let unit=source?.unit||"";
  if(name&&!unit)unit=/\bKPL\b/i.test(name)?"kpl.":/\bC-?RURA\b/i.test(name)?"mb":"szt.";
  ordered.push({id:source?.id||id(),lp,name,quantity:source?.quantity||"",unit});
 }
 return ordered;
}
function fileAsDataUrl(file:File){
 if(!file.type.startsWith("image/"))return new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsDataURL(file)});
 return new Promise<string>((resolve,reject)=>{
  const image=new Image(),url=URL.createObjectURL(file);
  image.onload=()=>{
   const top=Math.round(image.height*.25),height=Math.round(image.height*.73),width=image.width;
   const scale=Math.min(1.6,Math.max(.8,1400/width)),canvas=document.createElement("canvas");
   canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);
   const ctx=canvas.getContext("2d")!;ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);
   ctx.drawImage(image,0,top,width,height,0,0,canvas.width,canvas.height);URL.revokeObjectURL(url);
   resolve(canvas.toDataURL("image/jpeg",.92));
  };
  image.onerror=()=>{URL.revokeObjectURL(url);reject(new Error("Nie udało się przygotować zdjęcia"))};image.src=url;
 });
}
async function readWithAi(file:File){
 if(file.size>4*1024*1024)throw new Error("Plik jest większy niż 4 MB");
 const response=await fetch("/.netlify/functions/extract-invoice",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({dataUrl:await fileAsDataUrl(file),mimeType:file.type,fileName:file.name})});
 const data=await response.json();
 if(!response.ok)throw new Error(data?.error||"AI nie odczytało faktury");
 if(!Array.isArray(data.items)||!data.items.length)throw new Error("AI nie znalazło pozycji");
 return data.items.map((item:{lp?:number;name?:string;quantity?:string;unit?:string},index:number)=>({
  id:id(),lp:index+1,name:String(item.name||"").trim(),quantity:String(item.quantity||"").trim(),unit:String(item.unit||"").trim()
 }));
}
export default function Home(){
 const input=useRef<HTMLInputElement>(null);
 const [rows,setRows]=useState<Row[]>([]),[fileName,setFileName]=useState(""),[busy,setBusy]=useState(false),[progress,setProgress]=useState(0),[message,setMessage]=useState("Wczytaj fakturę, aby rozpocząć");
 useEffect(()=>{if("serviceWorker"in navigator)navigator.serviceWorker.register("/sw.js").catch(()=>undefined)},[]);
 const count=useMemo(()=>rows.filter(r=>r.name.trim()).length,[rows]);
 const update=(rowId:string,field:"name"|"quantity"|"unit",value:string)=>setRows(a=>a.map(r=>r.id===rowId?{...r,[field]:value}:r));
 const remove=(rowId:string)=>setRows(a=>a.filter(r=>r.id!==rowId).map((r,i)=>({...r,lp:i+1})));
 const clearAll=()=>{
  if(!rows.length&&!fileName)return;
  if(!window.confirm("Usunąć wszystkie pozycje i dane wczytanej faktury?"))return;
  setRows([]);setFileName("");setProgress(0);setMessage("Usunięto stare dane. Możesz wczytać nową fakturę.");
  if(input.current)input.current.value="";
 };
 async function images(file:File){
  if(!file.type.includes("pdf")){const source=URL.createObjectURL(file);return[{full:await prepareForOcr(source),names:await prepareNameColumn(source)}]}
  const pdfjs=await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc=new URL("pdfjs-dist/build/pdf.worker.min.mjs",import.meta.url).toString();
  const pdf=await pdfjs.getDocument({data:await file.arrayBuffer()}).promise,out:{full:string;names:string}[]=[];
  for(let n=1;n<=pdf.numPages;n++){const page=await pdf.getPage(n),view=page.getViewport({scale:2}),canvas=document.createElement("canvas");canvas.width=view.width;canvas.height=view.height;await page.render({canvas,canvasContext:canvas.getContext("2d")!,viewport:view}).promise;const source=canvas.toDataURL("image/png");out.push({full:await prepareForOcr(source),names:await prepareNameColumn(source)})}
  return out;
 }
 async function nativePdfText(file:File){
  if(!file.type.includes("pdf"))return"";
  const pdfjs=await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc=new URL("pdfjs-dist/build/pdf.worker.min.mjs",import.meta.url).toString();
  const pdf=await pdfjs.getDocument({data:await file.arrayBuffer()}).promise;let result="";
  for(let n=1;n<=pdf.numPages;n++){
   const page=await pdf.getPage(n),content=await page.getTextContent();
   const lines=new Map<number,{x:number;text:string}[]>();
   for(const raw of content.items){
    const item=raw as {str?:string;transform?:number[]};
    if(!item.str||!item.transform)continue;
    const y=Math.round(item.transform[5]/3)*3,x=item.transform[4];
    const line=lines.get(y)||[];line.push({x,text:item.str});lines.set(y,line);
   }
   result+=[...lines.entries()].sort((a,b)=>b[0]-a[0]).map(([,items])=>items.sort((a,b)=>a.x-b.x).map(v=>v.text).join(" ")).join("\n")+"\n";
  }
  return result;
 }
 async function read(file:File){
  setBusy(true);setProgress(4);setFileName(file.name);setMessage("Przygotowuję dokument…");
  try{
   try{
    setProgress(12);setMessage("AI odczytuje wszystkie pozycje faktury…");
    const aiRows=await readWithAi(file);
    setRows(aiRows);setProgress(100);setMessage(`AI rozpoznało ${aiRows.length} pozycji. Sprawdź dane.`);
    return;
   }catch(aiError){
    console.warn("Odczyt AI niedostępny, uruchamiam OCR",aiError);
    setMessage("AI jest chwilowo niedostępne — uruchamiam odczyt lokalny…");setProgress(5);
   }
   let text=await nativePdfText(file);
   if(text.length<150||!/(nazwa|towaru|ilość|jedn)/i.test(text)){
    const pages=await images(file),module=await import("tesseract.js"),T=module.default;
    const worker=await T.createWorker(["pol","eng"],T.OEM.LSTM_ONLY,{logger:e=>{if(e.status==="recognizing text"){setProgress(Math.round(e.progress*100));setMessage("Odczytuję i porządkuję tabelę…")}}});
    await worker.setParameters({tessedit_pageseg_mode:T.PSM.SINGLE_BLOCK,preserve_interword_spaces:"1",user_defined_dpi:"300"});
    text="";let namesText="";
    for(let i=0;i<pages.length;i++){
     setMessage(`Odczytuję tabelę na stronie ${i+1} z ${pages.length}…`);const result=await worker.recognize(pages[i].full);text+="\n"+result.data.text;
     setMessage(`Odczytuję nazwy na stronie ${i+1} z ${pages.length}…`);const nameResult=await worker.recognize(pages[i].names);namesText+="\n"+nameResult.data.text;
    }
    await worker.terminate();
    const found=sequenceRows(parseText(text),parseNames(namesText));
    setRows(found);setProgress(100);setMessage(found.length?`Rozpoznano ${found.length} pozycji. Sprawdź dane.`:"Nie rozpoznano tabeli. Dodaj pozycje ręcznie lub użyj wyraźniejszego skanu.");
    return;
   }else{setProgress(90);setMessage("Odczytuję tabelę bezpośrednio z PDF…")}
   const found=sequenceRows(parseText(text),new Map());setRows(found);setProgress(100);setMessage(found.length?`Rozpoznano ${found.length} pozycji. Sprawdź dane.`:"Nie rozpoznano tabeli. Dodaj pozycje ręcznie lub użyj wyraźniejszego skanu.");
  }catch(e){console.error(e);setMessage("Nie udało się odczytać dokumentu. Spróbuj wyraźniejszego zdjęcia lub PDF.")}finally{setBusy(false)}
 }
 async function exportPdf(){
  const pdfMakeModule=await import("pdfmake/build/pdfmake");
  const fontsModule=await import("pdfmake/build/vfs_fonts");
  const pdfMake=pdfMakeModule.default;
  pdfMake.vfs=fontsModule.default;
  const body=[
   [{text:"Lp.",bold:true},{text:"Nazwa towaru lub usługi",bold:true},{text:"Ilość",bold:true},{text:"Jedn.m",bold:true}],
   ...rows.map(r=>[String(r.lp),r.name,r.quantity,r.unit])
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
    <div className="actions"><div className="action-group"><button className="secondary" onClick={()=>setRows(a=>[...a,{id:id(),lp:a.length+1,name:"",quantity:"1",unit:"szt."}])}><Plus size={18}/>Dodaj pozycję</button><button className="danger" onClick={clearAll} disabled={!rows.length&&!fileName}><Trash2 size={18}/>Usuń wszystko</button></div><button className="primary" onClick={exportPdf} disabled={!count}><Download size={18}/>Utwórz PDF</button></div>
   </section>
  </section><footer>Po wygenerowaniu pliku możesz go wydrukować albo zapisać w dokumentacji.</footer>
 </main>
}
