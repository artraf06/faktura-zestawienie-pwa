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
 if(v&&typeof v==="object"&&"formula" in v){const r=(v as {result?:unknown}).result;return r===undefined||r===null?"ƒ":typeof r==="number"?String(Math.round(r*100)/100).replace(".",","):String(r)}
 return tekstKomorki(v);
};
const LEPKIE=300; // szerokość kolumn przyklejonych (#, Lp, nazwa)
const ile=(n:number)=>String(Math.round(n*100)/100).replace(".",",");

/** Podgląd arkusza z umową: prawdziwe wartości i kolory z pliku + podgląd tego, co zostanie dopisane z bieżącej faktury. */
export default function ExcelPodglad({umowa,wersja,oczekujace,wybrany,onWybierz}:{umowa:Umowa;wersja:number;oczekujace:Oczekujacy[];wybrany:number|null;onWybierz:(idx:number)=>void}){
 const wrap=useRef<HTMLDivElement>(null);
 const [tylkoWpisy,setTylkoWpisy]=useState(false);

 const {kolumny,wiersze}=useMemo(()=>{
  const ws=umowa.arkusz,h=umowa.wNaglowek,ost=umowa.wiersze.length?umowa.wiersze[umowa.wiersze.length-1].row:h;
  const doRow=Math.min(ws.rowCount,ost+3,h+1500);
  const naglowek=(col:number)=>{const t=pokaz(ws.getRow(h).getCell(col).value).trim();return t||(h>1?pokaz(ws.getRow(h-1).getCell(col).value).trim():"")};
  const cols:number[]=[];
  for(let c=1;c<=Math.min(ws.columnCount,80);c++){
   if(naglowek(c)){cols.push(c);continue}
   for(let r=h+1;r<=doRow;r++)if(pokaz(ws.getRow(r).getCell(c).value).trim()){cols.push(c);break}
  }
  // Lp i nazwa zawsze na początku (przyklejone przy przewijaniu w bok)
  const przod=[umowa.kolLp,umowa.kolNazwa].filter(c=>c&&cols.includes(c));
  const kolumny=[...przod,...cols.filter(c=>!przod.includes(c))].map(c=>({col:c,tytul:naglowek(c)||"",miesiac:umowa.miesiace.some(m=>m.col===c)}));
  const wiersze=[];
  for(let r=h+1;r<=doRow;r++){
   const row=ws.getRow(r);
   const komorki=kolumny.map(k=>{const c=row.getCell(k.col);return {t:pokaz(c.value),bg:kolor(c),notka:c.note?(typeof c.note==="string"?c.note:c.note.texts?.map(t=>t.text).join("")??""):""}});
   if(komorki.every(k=>!k.t.trim()||/^[A-Z]{1,2}$/.test(k.t.trim())))continue; // pusty wiersz albo wiersz z literami kolumn
   wiersze.push({r,komorki});
  }
  return {kolumny,wiersze};
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[umowa,wersja]);

 const mapa=useMemo(()=>{const m=new Map<string,{ilosc:number;pewne:boolean;idx:number[]}>();
  for(const o of oczekujace){const k=o.row+":"+o.col,b=m.get(k);if(b){b.ilosc+=o.ilosc;b.pewne&&=o.pewne;b.idx.push(o.idx)}else m.set(k,{ilosc:o.ilosc,pewne:o.pewne,idx:[o.idx]})}
  return m},[oczekujace]);
 const wiersz=wybrany!==null?oczekujace.find(o=>o.idx===wybrany):undefined;
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
   <span className="xls-leg"><i className="l-zolty"/>do sprawdzenia{niepewne?` (${niepewne})`:""}</span>
   <span className="xls-leg"><i className="l-zielony"/>pewne</span>
   <span className="xls-leg"><i className="l-plik"/>kolor z pliku</span>
   {oczekujace.length>0&&<label className="xls-filtr"><input type="checkbox" checked={tylkoWpisy} onChange={e=>setTylkoWpisy(e.target.checked)}/>tylko wiersze z tej faktury</label>}
  </div>
  <div className="xls-okno" ref={wrap}>
   <table className="xls-tab"><thead><tr><th className="xls-nr">#</th>{kolumny.map((k,i)=><th key={k.col} className={(i<2&&(k.col===umowa.kolLp||k.col===umowa.kolNazwa)?"xls-lepki"+i:"")+(k.miesiac?" xls-mies":"")} title={k.tytul}>{k.tytul}</th>)}</tr></thead>
    <tbody>{widoczne.map(w=><tr key={w.r} data-row={w.r} className={wiersz?.row===w.r?"xls-wybrany":wierszeZWpisem.has(w.r)?"xls-zwpisem":""}>
     <td className="xls-nr">{w.r}</td>
     {w.komorki.map((c,i)=>{
      const k=kolumny[i],o=mapa.get(w.r+":"+k.col),lepki=i<2&&(k.col===umowa.kolLp||k.col===umowa.kolNazwa)?"xls-lepki"+i:"";
      const cls=[lepki,o?(o.pewne?"xls-nowy-ok":"xls-nowy-uwaga"):"",o&&wiersz?.row===w.r&&wiersz.col===k.col?"xls-cel":"",c.notka?"xls-notka":""].join(" ");
      return <td key={k.col} data-col={k.col} className={cls} style={!o&&c.bg?{background:c.bg}:undefined}
        title={[o?`Z tej faktury: +${ile(o.ilosc)}${o.pewne?"":" (do sprawdzenia)"}`:"",c.notka].filter(Boolean).join("\n")||(i===1?c.t:undefined)}
        onClick={o?()=>onWybierz(o.idx[0]):undefined}>
       {o?<><span className="xls-bylo">{c.t}</span><b>+{ile(o.ilosc)}</b></>:c.t}
      </td>})}
    </tr>)}</tbody></table>
  </div>
  <div className="podglad-pomoc">Podgląd arkusza „{umowa.arkusz.name}”. „+ilość” to wpis z bieżącej faktury (jeszcze nie zapisany) — kliknij go, aby zaznaczyć pozycję. Komórki z notatką mają róg ◤.</div>
 </div>;
}
