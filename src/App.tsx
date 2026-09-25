"use client";
import {useEffect,useMemo,useRef,useState} from "react";
import {FileImage,FileText,LoaderCircle,Plus,ScanText,Trash2,Download,ShieldCheck,TriangleAlert,Eye,EyeOff} from "lucide-react";
import type {Worker as TWorker} from "tesseract.js";
import {odczytajTabele,type Gray,type OcrFn,type OcrWord,type Pozycja} from "./tableOcr";
import {pozycjeZPdf,pozycjeZeSlow,type PdfItem} from "./pdfTabela";
import Podglad,{type Strona,type Zaznaczenie} from "./Podglad";
type Row={id:string;lp:number;name:string;quantity:string;unit:string;uwaga?:string;strona?:number;y?:number;wys?:number;kat?:number};
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
const SZEROKOSC=2600;
// pozwala podać własne ścieżki plików OCR (np. do testów lub pracy offline)
const opcjeTesseract=()=>((globalThis as {__tesseractOptions?:object}).__tesseractOptions||{});
// obraz (zdjęcie lub strona PDF) → skala szarości o stałej szerokości
function doSzarosci(zrodlo:CanvasImageSource,w:number,h:number):Gray{
 const scale=SZEROKOSC/w,W=SZEROKOSC,H=Math.round(h*scale),canvas=document.createElement("canvas");
 canvas.width=W;canvas.height=H;
 const ctx=canvas.getContext("2d",{willReadFrequently:true})!;
 ctx.fillStyle="#fff";ctx.fillRect(0,0,W,H);ctx.imageSmoothingQuality="high";ctx.drawImage(zrodlo,0,0,W,H);
 const px=ctx.getImageData(0,0,W,H).data,d=new Uint8Array(W*H);
 for(let i=0;i<d.length;i++)d[i]=(px[i*4]*299+px[i*4+1]*587+px[i*4+2]*114)/1000;
 return {w:W,h:H,d};
}
function szaryDoCanvas(g:Gray,scale:number){
 const src=document.createElement("canvas");src.width=g.w;src.height=g.h;
 const sctx=src.getContext("2d")!,img=sctx.createImageData(g.w,g.h);
 for(let i=0;i<g.d.length;i++){img.data[i*4]=img.data[i*4+1]=img.data[i*4+2]=g.d[i];img.data[i*4+3]=255}
 sctx.putImageData(img,0,0);
 const out=document.createElement("canvas");out.width=Math.round(g.w*scale)+20;out.height=Math.round(g.h*scale)+20;
 const ctx=out.getContext("2d")!;ctx.fillStyle="#fff";ctx.fillRect(0,0,out.width,out.height);ctx.imageSmoothingQuality="high";
 ctx.drawImage(src,10,10,Math.round(g.w*scale),Math.round(g.h*scale));
 return out;
}
function ocrPrzez(worker:TWorker):OcrFn{
 let ostatnie="";
 return async(img,o)=>{
  if(img.w<3||img.h<3)return[];
  const klucz=`${o.psm}|${o.whitelist||""}`;
  if(klucz!==ostatnie){await worker.setParameters({tessedit_pageseg_mode:String(o.psm) as never,tessedit_char_whitelist:o.whitelist||""});ostatnie=klucz}
  const r=await worker.recognize(szaryDoCanvas(img,o.scale),{},{blocks:true});
  const out:OcrWord[]=[];let nr=0;
  for(const b of r.data.blocks||[])for(const p of b.paragraphs)for(const l of p.lines){nr++;for(const w of l.words){
   const t=w.text.trim();if(!t)continue;
   out.push({t,x:(w.bbox.x0-10)/o.scale,y:(w.bbox.y0-10)/o.scale,w:(w.bbox.x1-w.bbox.x0)/o.scale,h:(w.bbox.y1-w.bbox.y0)/o.scale,conf:w.confidence,line:nr});
  }}
  return out;
 };
}
async function wczytajPdf(file:File){
 const pdfjs=await import("pdfjs-dist");
 pdfjs.GlobalWorkerOptions.workerSrc=new URL("pdfjs-dist/build/pdf.worker.min.mjs",import.meta.url).toString();
 return pdfjs.getDocument({data:await file.arrayBuffer()}).promise;
}
export default function Home(){
 const input=useRef<HTMLInputElement>(null);
 const [rows,setRows]=useState<Row[]>([]),[fileName,setFileName]=useState(""),[busy,setBusy]=useState(false),[progress,setProgress]=useState(0),[message,setMessage]=useState("Wczytaj fakturę, aby rozpocząć");
 const [podglady,setPodglady]=useState<Strona[]>([]),[pokazPodglad,setPokazPodglad]=useState(true),[wybrany,setWybrany]=useState<string|null>(null);
 const zaznaczenie=useMemo<Zaznaczenie>(()=>{const r=rows.find(r=>r.id===wybrany);return r&&r.strona!==undefined&&r.y!==undefined?{strona:r.strona,y:r.y,wys:r.wys||0.02,kat:r.kat}:null},[rows,wybrany]);
 const zwolnijPodglady=()=>setPodglady(a=>{a.forEach(p=>URL.revokeObjectURL(p.src));return[]});
 useEffect(()=>{if("serviceWorker"in navigator)navigator.serviceWorker.register("/sw.js").catch(()=>undefined)},[]);
 const count=useMemo(()=>rows.filter(r=>r.name.trim()).length,[rows]);
 const update=(rowId:string,field:"name"|"quantity"|"unit",value:string)=>setRows(a=>a.map(r=>r.id===rowId?{...r,[field]:value,uwaga:undefined}:r));
 const remove=(rowId:string)=>setRows(a=>a.filter(r=>r.id!==rowId).map((r,i)=>({...r,lp:i+1})));
 const clearAll=()=>{
  if(!rows.length&&!fileName)return;
  if(!window.confirm("Usunąć wszystkie pozycje i dane wczytanej faktury?"))return;
  setRows([]);zwolnijPodglady();setWybrany(null);setFileName("");setProgress(0);setMessage("Usunięto stare dane. Możesz wczytać nową fakturę.");
  if(input.current)input.current.value="";
 };
 async function read(files:File[]){
  if(!files.length)return;const file=files[0];
  setBusy(true);setProgress(3);setFileName(files.length===1?file.name:`${files.length} pliki: ${files.map(item=>item.name).join(", ")}`);setMessage("Przygotowuję dokument…");
  let worker:TWorker|null=null;
  const dajWorker=async()=>{
   if(worker)return worker;
   setMessage("Ładuję moduł rozpoznawania tekstu…");
   const T=(await import("tesseract.js")).default;
   worker=await T.createWorker(["pol","eng"],T.OEM.LSTM_ONLY,opcjeTesseract());
   await worker.setParameters({preserve_interword_spaces:"1",user_defined_dpi:"300"});
   return worker;
  };
  zwolnijPodglady();setWybrany(null);
  const nowePodglady:Strona[]=[];
  const dodajPodglad=async(zrodlo:Blob|HTMLCanvasElement)=>{
   const blob=zrodlo instanceof Blob?zrodlo:await new Promise<Blob>(ok=>zrodlo.toBlob(b=>ok(b!),"image/jpeg",0.9));
   const bmp=await createImageBitmap(blob,{imageOrientation:"from-image"});const wym={w:bmp.width,h:bmp.height};bmp.close();
   nowePodglady.push({src:URL.createObjectURL(blob),...wym});setPodglady([...nowePodglady]);
   return nowePodglady.length-1;
  };
  try{
   // lista stron do odczytu: [obraz lub gotowe pozycje z tekstu PDF]
   const strony:({poz:Pozycja[];podglad:number}|{obraz:()=>Promise<Gray>;zrodlo:()=>Promise<string>;podglad:number})[]=[];
   for(const f of files){
    if(f.type.includes("pdf")||/\.pdf$/i.test(f.name)){
     const pdf=await wczytajPdf(f),tekst:PdfItem[][]=[];
     for(let n=1;n<=pdf.numPages;n++){
      const c=await (await pdf.getPage(n)).getTextContent();
      tekst.push((c.items as {str?:string;transform?:number[];width?:number}[]).filter(i=>i.str!==undefined&&i.transform).map(i=>({str:i.str!,x:i.transform![4],y:i.transform![5],w:i.width||0})));
     }
     const pierwsza=nowePodglady.length,wysokosci:number[]=[];
     for(let n=1;n<=pdf.numPages;n++){
      const page=await pdf.getPage(n),v1=page.getViewport({scale:1}),view=page.getViewport({scale:Math.min(3,1600/v1.width)}),canvas=document.createElement("canvas");
      wysokosci.push(v1.height);canvas.width=view.width;canvas.height=view.height;
      await page.render({canvas,canvasContext:canvas.getContext("2d")!,viewport:view}).promise;await dodajPodglad(canvas);
     }
     const poz=pozycjeZPdf(tekst,1,(y,nr)=>1-y/wysokosci[nr]);
     if(poz.length){strony.push({poz,podglad:pierwsza});continue}
     for(let n=1;n<=pdf.numPages;n++){
      const render=async()=>{const page=await pdf.getPage(n),v1=page.getViewport({scale:1}),view=page.getViewport({scale:Math.min(8,SZEROKOSC/v1.width)}),canvas=document.createElement("canvas");canvas.width=view.width;canvas.height=view.height;await page.render({canvas,canvasContext:canvas.getContext("2d")!,viewport:view}).promise;return canvas};
      strony.push({obraz:async()=>{const c=await render();return doSzarosci(c,c.width,c.height)},zrodlo:async()=>(await render()).toDataURL("image/png"),podglad:pierwsza+n-1});
     }
    }else{
     const podglad=await dodajPodglad(f);
     strony.push({
      podglad,
      obraz:async()=>{const bmp=await createImageBitmap(f,{imageOrientation:"from-image"});try{return doSzarosci(bmp,bmp.width,bmp.height)}finally{bmp.close()}},
      zrodlo:async()=>URL.createObjectURL(f),
     });
    }
   }
   const wynik:Pozycja[]=[];
   for(let i=0;i<strony.length;i++){
    const s=strony[i],baza=Math.round((i/strony.length)*95),krok=95/strony.length;
    if("poz" in s){wynik.push(...s.poz.map(p=>({...p,strona:s.podglad+(p.strona||0)})));continue}
    const w=await dajWorker();
    const naStronie=strony.length>1?` (strona ${i+1} z ${strony.length})`:"";
    const obraz=await s.obraz(),ocr=ocrPrzez(w);
    let poz=await odczytajTabele(obraz,ocr,(p,opis)=>{setProgress(baza+Math.round(p*krok/100));setMessage(opis+naStronie)});
    if(!poz.length){
     // tabela bez linii: kolumny wg położenia nagłówków
     setMessage(`Nie znalazłem linii tabeli${naStronie} — szukam kolumn po nagłówkach…`);
     poz=pozycjeZeSlow(await ocr(obraz,{psm:6,scale:1}),obraz.w,obraz.h);
    }
    if(!poz.length){
     setMessage(`Czytam cały tekst${naStronie}…`);
     poz=await odczytZwykly(await s.zrodlo());
    }
    wynik.push(...poz.map(p=>({...p,strona:s.podglad})));
   }
   const found:Row[]=wynik.map((p,i)=>({id:id(),lp:i+1,name:p.name,quantity:p.quantity,unit:p.unit,uwaga:p.uwaga,strona:p.strona,y:p.y,wys:p.wys,kat:p.kat}));
   setRows(found);setProgress(100);
   const doSprawdzenia=found.filter(r=>r.uwaga).length;
   setMessage(!found.length?"Nie rozpoznano tabeli. Dodaj pozycje ręcznie lub użyj wyraźniejszego zdjęcia/skanu.":`Rozpoznano ${found.length} pozycji.`+(doSprawdzenia?` ${doSprawdzenia} zaznaczono na żółto — sprawdź je.`:" Sprawdź dane przed eksportem."));
  }catch(e){console.error(e);setMessage("Nie udało się odczytać dokumentu. Spróbuj wyraźniejszego zdjęcia lub PDF.")}finally{setBusy(false);if(worker)await (worker as TWorker).terminate()}
 }
 // awaryjnie: stary odczyt całego tekstu (dla faktur bez linii tabeli)
 async function odczytZwykly(zrodlo:string):Promise<Pozycja[]>{
  const full=await prepareForOcr(zrodlo),names=await prepareNameColumn(zrodlo);
  const T=(await import("tesseract.js")).default;
  const w=await T.createWorker(["pol","eng"],T.OEM.LSTM_ONLY,opcjeTesseract());
  try{
   await w.setParameters({tessedit_pageseg_mode:T.PSM.SINGLE_BLOCK,preserve_interword_spaces:"1",user_defined_dpi:"300"});
   const text=(await w.recognize(full)).data.text,namesText=(await w.recognize(names)).data.text;
   return sequenceRows(parseText(text),parseNames(namesText)).map(r=>({lp:r.lp,name:r.name,quantity:r.quantity,unit:r.unit,uwaga:"Odczyt bez tabeli — sprawdź"}));
  }finally{await w.terminate()}
 }
 async function exportPdf(){
  const pdfMakeModule=await import("pdfmake/build/pdfmake");
  const fontsModule=await import("pdfmake/build/vfs_fonts");
  const pdfMake=pdfMakeModule.default;
  (pdfMake as unknown as {vfs:unknown}).vfs=fontsModule.default;
  const body=[
   [{text:"Lp.",bold:true},{text:"Nazwa towaru lub usługi",bold:true},{text:"Ilość",bold:true},{text:"Jedn.m",bold:true}],
   ...rows.map(r=>[String(r.lp),r.name,r.quantity,r.unit])
  ];
  pdfMake.createPdf({
   pageSize:"A4",pageMargins:[36,42,36,42],
   content:[
    {text:"ZESTAWIENIE TOWARÓW I USŁUG",fontSize:15,bold:true,margin:[0,0,0,14]},
    {table:{headerRows:1,widths:[28,"*",45,48],body,dontBreakRows:true},layout:{fillColor:(row:number)=>row===0?"#ebeff4":null}}
   ],
   footer:(currentPage:number,pageCount:number)=>({text:`Strona ${currentPage} z ${pageCount}`,alignment:"right",margin:[0,10,36,0],fontSize:8,color:"#65748a"}),
   defaultStyle:{font:"Roboto",fontSize:9}
  }).download(`zestawienie-${new Date().toISOString().slice(0,10)}.pdf`);
 }
 async function exportWord(){
  const {AlignmentType,BorderStyle,Document,Packer,Paragraph,Table,TableCell,TableLayoutType,TableRow,TextRun,VerticalAlign,WidthType}=await import("docx");
  const widths=[650,7116,1300,1400],border={style:BorderStyle.SINGLE,size:4,color:"B7C1CE"};
  const cell=(text:string,width:number,bold=false,alignment:(typeof AlignmentType)[keyof typeof AlignmentType]=AlignmentType.LEFT,fill?:string)=>new TableCell({
   width:{size:width,type:WidthType.DXA},verticalAlign:VerticalAlign.CENTER,
   margins:{top:100,bottom:100,left:120,right:120},borders:{top:border,bottom:border,left:border,right:border},
   shading:fill?{fill}:undefined,
   children:[new Paragraph({alignment,spacing:{before:0,after:0},children:[new TextRun({text,bold,font:"Arial",size:18})]})]
  });
  const tableRows=[
   new TableRow({tableHeader:true,children:[cell("Lp.",widths[0],true,AlignmentType.CENTER,"E9EEF5"),cell("Nazwa towaru lub usługi",widths[1],true,AlignmentType.LEFT,"E9EEF5"),cell("Ilość",widths[2],true,AlignmentType.CENTER,"E9EEF5"),cell("Jedn.m",widths[3],true,AlignmentType.CENTER,"E9EEF5")]}),
   ...rows.map(row=>new TableRow({cantSplit:true,children:[cell(String(row.lp),widths[0],false,AlignmentType.CENTER),cell(row.name,widths[1]),cell(row.quantity,widths[2],false,AlignmentType.CENTER),cell(row.unit,widths[3],false,AlignmentType.CENTER)]}))
  ];
  const wordDoc=new Document({styles:{default:{document:{run:{font:"Arial",size:18}}}},sections:[{
   properties:{page:{size:{width:11906,height:16838},margin:{top:720,right:720,bottom:720,left:720}}},
   children:[
    new Paragraph({spacing:{after:280},children:[new TextRun({text:"ZESTAWIENIE TOWARÓW I USŁUG",bold:true,font:"Arial",size:30})]}),
    new Table({width:{size:10466,type:WidthType.DXA},layout:TableLayoutType.FIXED,columnWidths:widths,rows:tableRows})
   ]
  }]});
  const blob=await Packer.toBlob(wordDoc),url=URL.createObjectURL(blob),link=document.createElement("a");
  link.href=url;link.download=`zestawienie-${new Date().toISOString().slice(0,10)}.docx`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 return <main className="app-shell">
  <header className="topbar"><div className="brand-mark"><ScanText size={25}/></div><div><h1>Faktura → Zestawienie</h1><p>Odczyt pozycji z JPG i PDF</p></div><div className="privacy"><ShieldCheck size={18}/><span>Dane przetwarzane na tym urządzeniu</span></div></header>
  <section className={"workspace"+(podglady.length&&pokazPodglad?" z-podgladem":"")}>
   <aside className="upload-card"><div className="step">KROK 1</div><h2>Wczytaj fakturę</h2>
    <button className="dropzone" onClick={()=>input.current?.click()} disabled={busy}>{fileName?<FileText size={34}/>:<FileImage size={34}/>}<strong>{fileName||"Wybierz JPG lub PDF"}</strong><span>{fileName?"Kliknij, aby zmienić dokument":"Wyraźny skan daje najlepszy wynik"}</span></button>
    <input ref={input} hidden multiple type="file" accept="image/jpeg,image/png,application/pdf" onChange={e=>e.target.files&&read(Array.from(e.target.files))}/>
    <div className="status"><div>{busy&&<LoaderCircle className="spin" size={18}/>}<span>{message}</span></div>{(busy||progress>0)&&<div className="progress"><i style={{width:`${progress}%`}}/></div>}</div>
    <div className="tip"><strong>Ważne</strong><p>Odczyt działa bez AI, w całości na tym urządzeniu. Wiersze zaznaczone na żółto sprawdź — najedź na nie, żeby zobaczyć powód. Poprawka pola zdejmuje zaznaczenie.</p></div>
   </aside>
   <section className="table-card"><div className="table-heading"><div><span className="step">KROK 2</span><h2>Sprawdź rozpoznane pozycje</h2></div><div className="heading-right">{podglady.length>0&&<button className="secondary maly" onClick={()=>setPokazPodglad(p=>!p)}>{pokazPodglad?<EyeOff size={16}/>:<Eye size={16}/>}{pokazPodglad?"Ukryj fakturę":"Pokaż fakturę"}</button>}<span className="count">{count} pozycji</span></div></div>
    <div className="table-wrap"><table><thead><tr><th>Lp.</th><th>Nazwa towaru lub usługi</th><th>Ilość</th><th>Jedn.m</th><th aria-label="Usuń"/></tr></thead><tbody>
     {rows.length?rows.map(r=><tr key={r.id} className={[r.uwaga?"uwaga":"",wybrany===r.id?"wybrany":""].join(" ").trim()||undefined} title={r.uwaga} onFocus={()=>setWybrany(r.id)} onClick={()=>setWybrany(r.id)}><td>{r.uwaga?<span className="znak" aria-label={r.uwaga}><TriangleAlert size={15}/></span>:null}{r.lp}</td><td><input value={r.name} onChange={e=>update(r.id,"name",e.target.value)} aria-label={`Nazwa pozycji ${r.lp}`}/></td><td><input className="short" value={r.quantity} onChange={e=>update(r.id,"quantity",e.target.value)} aria-label={`Ilość pozycji ${r.lp}`}/></td><td><input className="short" value={r.unit} onChange={e=>update(r.id,"unit",e.target.value)} aria-label={`Miara pozycji ${r.lp}`}/></td><td><button className="icon-btn" onClick={()=>remove(r.id)} aria-label={`Usuń pozycję ${r.lp}`}><Trash2 size={17}/></button></td></tr>):<tr><td colSpan={5} className="empty">Brak pozycji. Wczytaj dokument lub dodaj pusty wiersz.</td></tr>}
    </tbody></table></div>
    <div className="actions"><div className="action-group"><button className="secondary" onClick={()=>setRows(a=>[...a,{id:id(),lp:a.length+1,name:"",quantity:"1",unit:"szt."}])}><Plus size={18}/>Dodaj pozycję</button><button className="danger" onClick={clearAll} disabled={!rows.length&&!fileName}><Trash2 size={18}/>Usuń wszystko</button></div><div className="export-group"><button className="secondary" onClick={exportWord} disabled={!count}><Download size={18}/>Utwórz Word</button><button className="primary" onClick={exportPdf} disabled={!count}><Download size={18}/>Utwórz PDF</button></div></div>
   </section>
   {podglady.length>0&&pokazPodglad&&<aside className="preview-card"><div className="preview-heading"><span className="step">PODGLĄD</span><h2>Faktura</h2></div><Podglad strony={podglady} zaznacz={zaznaczenie}/></aside>}
  </section><footer>Po wygenerowaniu pliku możesz go wydrukować albo zapisać w dokumentacji.</footer>
 </main>
}
