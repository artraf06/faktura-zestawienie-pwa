const namesSchema={type:"object",additionalProperties:false,required:["items"],properties:{items:{type:"array",items:{type:"object",additionalProperties:false,required:["lp","name"],properties:{lp:{type:"integer"},name:{type:"string"}}}}}};
const amountsSchema={type:"object",additionalProperties:false,required:["items"],properties:{items:{type:"array",items:{type:"object",additionalProperties:false,required:["lp","quantity","unit"],properties:{lp:{type:"integer"},quantity:{type:"string"},unit:{type:"string"}}}}}};
const outputText=result=>result.output_text||result.output?.flatMap(block=>block.content||[]).find(part=>part.type==="output_text")?.text;

async function analyze(apiKey,documentPart,prompt,schema,name){
 const response=await fetch("https://api.openai.com/v1/responses",{
  method:"POST",headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},
  body:JSON.stringify({model:"gpt-5-mini",input:[{role:"user",content:[{type:"input_text",text:prompt},documentPart]}],text:{format:{type:"json_schema",name,strict:true,schema}}})
 });
 const result=await response.json();
 if(!response.ok)throw new Error(result?.error?.message||"Błąd OpenAI API");
 const text=outputText(result);if(!text)throw new Error("AI nie zwróciło danych");
 return JSON.parse(text).items||[];
}

export default async(req)=>{
 if(req.method!=="POST")return new Response(JSON.stringify({error:"Method not allowed"}),{status:405,headers:{"content-type":"application/json"}});
 const apiKey=Netlify.env.get("OPENAI_API_KEY");
 if(!apiKey)return new Response(JSON.stringify({error:"Brak konfiguracji OPENAI_API_KEY"}),{status:500,headers:{"content-type":"application/json"}});
 try{
  const {dataUrl,mimeType,fileName}=await req.json();
  if(typeof dataUrl!=="string"||!dataUrl.startsWith("data:"))throw new Error("Nieprawidłowy plik");
  const documentPart=mimeType==="application/pdf"?{type:"input_file",filename:fileName||"faktura.pdf",file_data:dataUrl}:{type:"input_image",image_url:dataUrl,detail:"high"};
  const [names,amounts]=await Promise.all([
   analyze(apiKey,documentPart,"Patrz WYŁĄCZNIE na kolumny Lp. oraz Nazwa towaru lub usługi na wszystkich stronach faktury. Zwróć dokładnie jeden rekord dla każdego drukowanego numeru Lp., w tej samej kolejności. Tekst bez własnego numeru Lp. jest dalszym ciągiem nazwy poprzedniego wiersza — połącz go, nigdy nie twórz z niego nowej pozycji. Nie czytaj PKWiU, ilości, jednostek ani cen. Zachowaj oryginalne nazwy i polskie znaki. Przed odpowiedzią sprawdź ciągłość numerów od pierwszego do ostatniego.",namesSchema,"invoice_names"),
   analyze(apiKey,documentPart,"Patrz WYŁĄCZNIE na drukowaną kolumnę Lp. oraz odpowiadające jej kolumny Ilość i Jedn.m na wszystkich stronach faktury. Dla każdego rzeczywistego numeru Lp. zwróć ilość i jednostkę z dokładnie tego samego poziomego wiersza. Nie zgaduj i nie kopiuj wartości z sąsiedniego wiersza. Nie czytaj nazw, PKWiU, cen, netto, VAT ani brutto. Jednostki zapisuj jak na fakturze, np. szt., kpl., mb. Przed odpowiedzią sprawdź każdy wiersz osobno oraz ciągłość numerów.",amountsSchema,"invoice_amounts")
  ]);
  const namesByLp=new Map(names.map(item=>[Number(item.lp),String(item.name||"").trim()]));
  const amountsByLp=new Map(amounts.map(item=>[Number(item.lp),item]));
  const positions=[...namesByLp.keys(),...amountsByLp.keys()].filter(lp=>Number.isInteger(lp)&&lp>0&&lp<1000);
  if(!positions.length)throw new Error("AI nie znalazło pozycji");
  const first=Math.min(...positions),last=Math.max(...positions),items=[];
  for(let lp=first;lp<=last;lp++){
   const amount=amountsByLp.get(lp)||{};
   items.push({lp,name:namesByLp.get(lp)||"",quantity:String(amount.quantity||"").trim(),unit:String(amount.unit||"").trim()});
  }
  return new Response(JSON.stringify({items}),{headers:{"content-type":"application/json","cache-control":"no-store"}});
 }catch(error){
  console.error("extract-invoice",error);
  return new Response(JSON.stringify({error:error instanceof Error?error.message:"Nie udało się odczytać faktury"}),{status:500,headers:{"content-type":"application/json"}});
 }
};

export const config={path:"/.netlify/functions/extract-invoice"};
