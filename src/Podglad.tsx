import {useCallback,useEffect,useRef,useState} from "react";
import {Maximize,Minus,Plus,Search,ChevronLeft,ChevronRight} from "lucide-react";

export type Strona={src:string;w:number;h:number};
export type Zaznaczenie={strona:number;y:number;wys:number;kat?:number}|null;

const LUPA_R=95,LUPA_ZOOM=2.5,MIN_S=0.05,MAX_S=8;

// Podgląd faktury: przesuwanie (przeciągnij), zoom (kółko, przyciski, dwa palce, dwuklik), lupa, podświetlenie wiersza
export default function Podglad({strony,zaznacz}:{strony:Strona[];zaznacz:Zaznaczenie}){
 const box=useRef<HTMLDivElement>(null);
 const [nr,setNr]=useState(0);
 const [v,setV]=useState({s:1,x:0,y:0});
 const [lupa,setLupa]=useState(false);
 const [kursor,setKursor]=useState<{x:number;y:number}|null>(null);
 const wskazniki=useRef(new Map<number,{x:number;y:number}>());
 const ciag=useRef<{x:number;y:number;vx:number;vy:number;d?:number;s?:number}|null>(null);
 const strona=strony[Math.min(nr,strony.length-1)];

 const dopasuj=useCallback(()=>{
  const el=box.current;if(!el||!strona)return;
  const s=Math.min(el.clientWidth/strona.w,MAX_S);
  setV({s,x:0,y:Math.max(0,(el.clientHeight-strona.h*s)/2)});
 },[strona]);
 useEffect(()=>{dopasuj()},[dopasuj,nr,strony.length]);
 useEffect(()=>{const el=box.current;if(!el)return;const ro=new ResizeObserver(()=>dopasuj());ro.observe(el);return()=>ro.disconnect()},[dopasuj]);

 // po kliknięciu wiersza w tabeli: przejdź do strony i pokaż ten wiersz na środku
 useEffect(()=>{
  if(!zaznacz||!strony[zaznacz.strona])return;
  if(zaznacz.strona!==nr){setNr(zaznacz.strona);return}
  const el=box.current;if(!el)return;
  const st=strony[zaznacz.strona];
  setV(o=>{
   const s=Math.max(o.s,(el.clientWidth/st.w)*1.6);
   return {s,x:Math.min(0,Math.max(o.x*(s/o.s),el.clientWidth-st.w*s)),y:el.clientHeight/2-zaznacz.y*st.h*s};
  });
 },[zaznacz,nr,strony]);

 const zoomWokol=(px:number,py:number,f:number)=>setV(o=>{
  const s=Math.min(MAX_S,Math.max(MIN_S,o.s*f)),k=s/o.s;
  return {s,x:px-(px-o.x)*k,y:py-(py-o.y)*k};
 });
 const punkt=(e:{clientX:number;clientY:number})=>{const r=box.current!.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top}};

 useEffect(()=>{
  const el=box.current;if(!el)return;
  const koło=(e:WheelEvent)=>{e.preventDefault();const p=punkt(e);zoomWokol(p.x,p.y,Math.exp(-e.deltaY*0.0015))};
  el.addEventListener("wheel",koło,{passive:false});
  return()=>el.removeEventListener("wheel",koło);
 },[]);

 const down=(e:React.PointerEvent)=>{
  (e.target as Element).setPointerCapture?.(e.pointerId);
  wskazniki.current.set(e.pointerId,punkt(e));
  const pts=[...wskazniki.current.values()];
  if(pts.length===1)ciag.current={x:pts[0].x,y:pts[0].y,vx:v.x,vy:v.y};
  else if(pts.length===2){const d=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);ciag.current={x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2,vx:v.x,vy:v.y,d,s:v.s}}
 };
 const move=(e:React.PointerEvent)=>{
  const p=punkt(e);
  if(e.pointerType==="mouse"||lupa)setKursor(p);
  if(!wskazniki.current.has(e.pointerId))return;
  wskazniki.current.set(e.pointerId,p);
  const pts=[...wskazniki.current.values()],c=ciag.current;if(!c)return;
  if(pts.length===2&&c.d&&c.s){
   const d=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y),s=Math.min(MAX_S,Math.max(MIN_S,c.s*d/c.d)),k=s/c.s;
   const mx=(pts[0].x+pts[1].x)/2,my=(pts[0].y+pts[1].y)/2;
   setV({s,x:mx-(c.x-c.vx)*k,y:my-(c.y-c.vy)*k});
  }else if(pts.length===1&&!(lupa&&e.pointerType!=="mouse")){
   setV(o=>({...o,x:c.vx+p.x-c.x,y:c.vy+p.y-c.y}));
  }
 };
 const up=(e:React.PointerEvent)=>{
  wskazniki.current.delete(e.pointerId);
  const pts=[...wskazniki.current.values()];
  ciag.current=pts.length===1?{x:pts[0].x,y:pts[0].y,vx:v.x,vy:v.y}:null;
  if(e.pointerType!=="mouse"&&!pts.length)setKursor(null);
 };
 const srodek=()=>{const el=box.current!;return {x:el.clientWidth/2,y:el.clientHeight/2}};

 if(!strona)return <div className="podglad-pusty">Tu pojawi się podgląd wczytanej faktury.</div>;
 const pas=zaznacz&&zaznacz.strona===nr?zaznacz:null;
 return <div className="podglad">
  <div className="podglad-pasek">
   {strony.length>1&&<div className="strony"><button onClick={()=>setNr(n=>Math.max(0,n-1))} disabled={nr===0} aria-label="Poprzednia strona"><ChevronLeft size={17}/></button><span>{nr+1} / {strony.length}</span><button onClick={()=>setNr(n=>Math.min(strony.length-1,n+1))} disabled={nr>=strony.length-1} aria-label="Następna strona"><ChevronRight size={17}/></button></div>}
   <button onClick={()=>{const c=srodek();zoomWokol(c.x,c.y,1/1.3)}} aria-label="Pomniejsz"><Minus size={17}/></button>
   <span className="procent">{Math.round(v.s*100)}%</span>
   <button onClick={()=>{const c=srodek();zoomWokol(c.x,c.y,1.3)}} aria-label="Powiększ"><Plus size={17}/></button>
   <button onClick={dopasuj} title="Dopasuj do szerokości"><Maximize size={16}/><span>Dopasuj</span></button>
   <button className={lupa?"wlaczona":""} onClick={()=>setLupa(l=>!l)} aria-pressed={lupa} title="Lupa"><Search size={16}/><span>Lupa</span></button>
  </div>
  <div ref={box} className={"podglad-okno"+(lupa?" z-lupa":"")} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={e=>{if(e.pointerType==="mouse")setKursor(null)}} onDoubleClick={e=>{const p=punkt(e);zoomWokol(p.x,p.y,2)}}>
   <div className="podglad-warstwa" style={{width:strona.w,height:strona.h,transform:`translate(${v.x}px,${v.y}px) scale(${v.s})`}}>
    <img src={strona.src} width={strona.w} height={strona.h} alt={`Strona ${nr+1} faktury`} draggable={false}/>
    {pas&&<div className="podglad-wiersz" style={{top:(pas.y-pas.wys/2)*strona.h,height:Math.max(pas.wys,0.012)*strona.h,borderWidth:2/v.s,transform:pas.kat?`rotate(${pas.kat}deg)`:undefined}}/>}
   </div>
   {lupa&&kursor&&<div className="lupa" style={{
    left:kursor.x-LUPA_R,top:kursor.y-LUPA_R,width:LUPA_R*2,height:LUPA_R*2,
    backgroundImage:`url("${strona.src}")`,
    backgroundSize:`${strona.w*v.s*LUPA_ZOOM}px ${strona.h*v.s*LUPA_ZOOM}px`,
    backgroundPosition:`${LUPA_R-(kursor.x-v.x)*LUPA_ZOOM}px ${LUPA_R-(kursor.y-v.y)*LUPA_ZOOM}px`,
   }}/>}
  </div>
  <div className="podglad-pomoc">Przeciągnij, aby przesunąć · kółko myszy lub dwa palce — zoom · dwuklik — przybliż · kliknij wiersz w tabeli, aby go tu pokazać</div>
 </div>;
}
