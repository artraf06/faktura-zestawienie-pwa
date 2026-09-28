// Wspólne: odczyt faktury (PDF z tekstem, skan, zdjęcie, Word) na tym urządzeniu – bez AI.
import type {Worker as TWorker} from "tesseract.js";
import {odczytajFakture,type Gray,type OcrFn,type OcrWord,type Pozycja} from "./tableOcr";
import {pozycjeZPdf,pozycjeZeSlow,type PdfItem} from "./pdfTabela";
import type {Strona} from "./Podglad";

export const SZEROKOSC=2600;
// pozwala podać własne ścieżki plików OCR (np. do testów lub pracy offline)
export const opcjeTesseract=()=>((globalThis as {__tesseractOptions?:object}).__tesseractOptions||{});
// obraz (zdjęcie lub strona PDF) → skala szarości o stałej szerokości
export function doSzarosci(zrodlo:CanvasImageSource,w:number,h:number):Gray{
 const scale=SZEROKOSC/w,W=SZEROKOSC,H=Math.round(h*scale),canvas=document.createElement("canvas");
 canvas.width=W;canvas.height=H;
 const ctx=canvas.getContext("2d",{willReadFrequently:true})!;
 ctx.fillStyle="#fff";ctx.fillRect(0,0,W,H);ctx.imageSmoothingQuality="high";ctx.drawImage(zrodlo,0,0,W,H);
 const px=ctx.getImageData(0,0,W,H).data,d=new Uint8Array(W*H);
 for(let i=0;i<d.length;i++)d[i]=(px[i*4]*299+px[i*4+1]*587+px[i*4+2]*114)/1000;
 return {w:W,h:H,d};
}
export function szaryDoCanvas(g:Gray,scale:number){
 const src=document.createElement("canvas");src.width=g.w;src.height=g.h;
 const sctx=src.getContext("2d")!,img=sctx.createImageData(g.w,g.h);
 for(let i=0;i<g.d.length;i++){img.data[i*4]=img.data[i*4+1]=img.data[i*4+2]=g.d[i];img.data[i*4+3]=255}
 sctx.putImageData(img,0,0);
 const out=document.createElement("canvas");out.width=Math.round(g.w*scale)+20;out.height=Math.round(g.h*scale)+20;
 const ctx=out.getContext("2d")!;ctx.fillStyle="#fff";ctx.fillRect(0,0,out.width,out.height);ctx.imageSmoothingQuality="high";
 ctx.drawImage(src,10,10,Math.round(g.w*scale),Math.round(g.h*scale));
 return out;
}
export function ocrPrzez(worker:TWorker):OcrFn{
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
export async function wczytajPdf(file:File){
 const pdfjs=await import("pdfjs-dist");
 pdfjs.GlobalWorkerOptions.workerSrc=new URL("pdfjs-dist/build/pdf.worker.min.mjs",import.meta.url).toString();
 return pdfjs.getDocument({data:await file.arrayBuffer()}).promise;
}

export type WynikFaktury={pozycje:Pozycja[];tekst:string;podglady:Strona[]};

/** Jedna faktura (plik) → pozycje z cenami netto + tekst do numeru i daty + obrazy stron do podglądu. */
export async function czytajFakture(f:File,postep:(p:number,opis:string)=>void,worker:()=>Promise<TWorker>):Promise<WynikFaktury>{
 const podglady:Strona[]=[];
 const dodaj=async(zr:Blob|HTMLCanvasElement)=>{
  const blob=zr instanceof Blob?zr:await new Promise<Blob>(ok=>zr.toBlob(b=>ok(b!),"image/jpeg",0.9));
  const bmp=await createImageBitmap(blob,{imageOrientation:"from-image"});const w=bmp.width,h=bmp.height;bmp.close();
  podglady.push({src:URL.createObjectURL(blob),w,h});
 };
 const nazwa=f.name.toLowerCase();
 if(/\.docx$/.test(nazwa))return {...await fakturaWord(f),podglady};
 if(/\.(doc|rtf|odt)$/.test(nazwa))throw new Error("Stary format Worda – otwórz plik w Wordzie, „Zapisz jako” .docx albo PDF i wczytaj ponownie.");
 if(f.type.includes("pdf")||nazwa.endsWith(".pdf")){
  const pdf=await wczytajPdf(f),tekst:PdfItem[][]=[],wys:number[]=[];
  for(let n=1;n<=pdf.numPages;n++){
   const page=await pdf.getPage(n),c=await page.getTextContent(),v1=page.getViewport({scale:1});
   wys.push(v1.height);
   tekst.push((c.items as {str?:string;transform?:number[];width?:number}[]).filter(i=>i.str!==undefined&&i.transform).map(i=>({str:i.str!,x:i.transform![4],y:i.transform![5],w:i.width||0})));
   const view=page.getViewport({scale:Math.min(3,1600/v1.width)}),cv=document.createElement("canvas");cv.width=view.width;cv.height=view.height;
   await page.render({canvas:cv,canvasContext:cv.getContext("2d")!,viewport:view}).promise;await dodaj(cv);
  }
  const poz=pozycjeZPdf(tekst,1,(y,nr)=>1-y/wys[nr]);
  if(poz.length){
   const t=tekst[0].slice().sort((a,b)=>b.y-a.y||a.x-b.x).map(i=>i.str).join(" ");
   return {pozycje:poz,tekst:t,podglady};
  }
  // skan w PDF: każda strona przez OCR
  const wynik:Pozycja[]=[];let t="";
  for(let n=1;n<=pdf.numPages;n++){
   const page=await pdf.getPage(n),v1=page.getViewport({scale:1}),view=page.getViewport({scale:Math.min(8,SZEROKOSC/v1.width)}),cv=document.createElement("canvas");
   cv.width=view.width;cv.height=view.height;await page.render({canvas:cv,canvasContext:cv.getContext("2d")!,viewport:view}).promise;
   const r=await ocrStrony(doSzarosci(cv,cv.width,cv.height),await worker(),(p,o)=>postep(Math.round(((n-1)+p/100)/pdf.numPages*100),o),n===1);
   wynik.push(...r.pozycje.map(p=>({...p,strona:n-1})));if(n===1)t=r.tekst;
  }
  return {pozycje:wynik,tekst:t,podglady};
 }
 await dodaj(f);
 const bmp=await createImageBitmap(f,{imageOrientation:"from-image"});
 const g=doSzarosci(bmp,bmp.width,bmp.height);bmp.close();
 const r=await ocrStrony(g,await worker(),postep,true);
 return {pozycje:r.pozycje.map(p=>({...p,strona:0})),tekst:r.tekst,podglady};
}

async function ocrStrony(g:Gray,w:TWorker,postep:(p:number,opis:string)=>void,naglowek:boolean){
 const ocr=ocrPrzez(w);
 const r=await odczytajFakture(g,ocr,postep,naglowek);
 if(r.pozycje.length)return r;
 postep(90,"Nie znalazłem linii tabeli – szukam kolumn po nagłówkach…");
 const slowa:OcrWord[]=await ocr(g,{psm:6,scale:1});
 const linie=new Map<number,string[]>();for(const s of slowa){const a=linie.get(s.line)||[];a.push(s.t);linie.set(s.line,a)}
 return {pozycje:pozycjeZeSlow(slowa,g.w,g.h),tekst:[...linie.values()].map(a=>a.join(" ")).join("\n")};
}

// ---------------- Word (.docx): tabele z dokumentu
async function fakturaWord(f:File):Promise<{pozycje:Pozycja[];tekst:string}>{
 const JSZip=(await import("jszip")).default;
 const zip=await JSZip.loadAsync(await f.arrayBuffer());
 const xml=await zip.file("word/document.xml")?.async("string");
 if(!xml)throw new Error("To nie jest poprawny plik Word (.docx).");
 const doc=new DOMParser().parseFromString(xml,"application/xml");
 const W="http://schemas.openxmlformats.org/wordprocessingml/2006/main";
 const tekstEl=(el:Element)=>[...el.getElementsByTagNameNS(W,"p")].map(p=>[...p.getElementsByTagNameNS(W,"t")].map(t=>t.textContent).join("")).join(" ").trim();
 const wiersze:string[][]=[];
 for(const tbl of [...doc.getElementsByTagNameNS(W,"tbl")])for(const tr of [...tbl.getElementsByTagNameNS(W,"tr")])wiersze.push([...tr.getElementsByTagNameNS(W,"tc")].map(tekstEl));
 const caly=[...doc.getElementsByTagNameNS(W,"p")].map(p=>[...p.getElementsByTagNameNS(W,"t")].map(t=>t.textContent).join("")).join("\n");
 return {pozycje:pozycjeZTabeli(wiersze),tekst:caly};
}

/** Tabela (wiersze komórek) → pozycje faktury, kolumny rozpoznane po nagłówkach. */
export function pozycjeZTabeli(wiersze:string[][]):Pozycja[]{
 const n=(t:string)=>t.toLowerCase().replace(/\s+/g," ");
 const iNag=wiersze.findIndex(r=>r.some(c=>/nazwa/.test(n(c)))&&r.some(c=>/ilo[śs][ćc]|^il\.?$/.test(n(c))));
 if(iNag<0)return [];
 const h=wiersze[iNag].map(n);
 const kol=(f:(t:string)=>boolean)=>h.findIndex(f);
 const cNazwa=kol(t=>/nazwa/.test(t)),cIl=kol(t=>/ilo[śs][ćc]|^il\.?$/.test(t)),cJm=kol(t=>/j\.? ?m|jedn|miara/.test(t)&&!/cena/.test(t));
 const cCN=kol(t=>/cena/.test(t)&&!/brutto/.test(t)),cCB=kol(t=>/cena/.test(t)&&/brutto/.test(t)),cWN=kol(t=>/warto/.test(t)&&/netto/.test(t)),cLp=kol(t=>/^l\.? ?p/.test(t));
 const num=(t?:string)=>{const m=(t||"").replace(/\s/g,"").match(/^\d+(?:[.,]\d+)?/);return m?Number(m[0].replace(",",".")):undefined};
 const out:Pozycja[]=[];
 for(const r of wiersze.slice(iNag+1)){
  const nazwa=(r[cNazwa]||"").trim();if(!nazwa||/^(razem|suma|ogółem)/i.test(nazwa))continue;
  const q=num(r[cIl]);if(q===undefined)continue;
  let cena=cCN>=0?num(r[cCN]):undefined,wyl=false;
  if(cena===undefined&&cWN>=0&&num(r[cWN])!==undefined&&q){cena=Math.round(num(r[cWN])!/q*100)/100;wyl=true}
  if(cena===undefined&&cCB>=0&&num(r[cCB])!==undefined){cena=Math.round(num(r[cCB])!/1.23*100)/100;wyl=true}
  out.push({lp:cLp>=0?Number(num(r[cLp])||out.length+1):out.length+1,name:nazwa,quantity:String(q).replace(".",","),unit:cJm>=0?r[cJm].trim():"",cenaNetto:cena,cenaWyliczona:wyl});
 }
 return out;
}
