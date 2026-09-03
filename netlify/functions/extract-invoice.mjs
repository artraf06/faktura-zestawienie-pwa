const schema={type:"object",additionalProperties:false,required:["items"],properties:{items:{type:"array",items:{type:"object",additionalProperties:false,required:["lp","name","quantity","unit"],properties:{lp:{type:"integer"},name:{type:"string"},quantity:{type:"string"},unit:{type:"string"}}}}}};
const getOutput=result=>result.output_text||result.output?.flatMap(block=>block.content||[]).find(part=>part.type==="output_text")?.text;

export default async(req)=>{
 if(req.method!=="POST")return new Response(JSON.stringify({error:"Method not allowed"}),{status:405,headers:{"content-type":"application/json"}});
 const apiKey=Netlify.env.get("OPENAI_API_KEY");
 if(!apiKey)return new Response(JSON.stringify({error:"Brak konfiguracji OPENAI_API_KEY"}),{status:500,headers:{"content-type":"application/json"}});
 try{
  const {dataUrl,dataUrls,mimeType,fileName}=await req.json();
  const urls=Array.isArray(dataUrls)?dataUrls:[dataUrl];
  if(!urls.length||urls.some(value=>typeof value!=="string"||!value.startsWith("data:")))throw new Error("Nieprawidłowy plik");
  const documentParts=mimeType==="application/pdf"?[{type:"input_file",filename:fileName||"faktura.pdf",file_data:urls[0]}]:urls.map(image_url=>({type:"input_image",image_url,detail:"high"}));
  const response=await fetch("https://api.openai.com/v1/responses",{
   method:"POST",headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},
   body:JSON.stringify({
    model:"gpt-4o",
    input:[{role:"user",content:[
     {type:"input_text",text:"To jest powiększona tabela pozycji z faktury. Obrazy przedstawiają kolejno górną i dolną część tej samej tabeli i mogą nieznacznie na siebie zachodzić — nie duplikuj powtarzających się wierszy. Odczytaj tabelę WIERSZ PO WIERSZU ze wszystkich części i stron. Kolumna Lp. jest jedynym wyznacznikiem nowej pozycji: utwórz dokładnie jeden rekord dla każdego wydrukowanego numeru Lp. Tekst bez własnego numeru Lp. jest kontynuacją nazwy wcześniejszej pozycji — połącz go z nią. Dla każdego Lp. patrz poziomo i odczytaj z tego samego wiersza pełną Nazwę towaru lub usługi, Ilość i Jedn.m. Nie zakładaj, że ilości są jednakowe; sprawdź każdą cyfrę oddzielnie. Nie przesuwaj danych między wierszami. Pomiń PKWiU, ceny, wartości, netto, VAT i brutto. Jeśli komórka jest nieczytelna, pozostaw pusty tekst, ale nie pomijaj numeru. Jednostki zapisuj dokładnie, np. szt., kpl., mb. Na końcu sprawdź ciągłość Lp. oraz zgodność każdego wiersza."},...documentParts
    ]}],
    text:{format:{type:"json_schema",name:"invoice_items",strict:true,schema}}
   })
  });
  const result=await response.json();if(!response.ok)throw new Error(result?.error?.message||"Błąd OpenAI API");
  const text=getOutput(result);if(!text)throw new Error("AI nie zwróciło danych");
  const parsed=JSON.parse(text);if(!parsed.items?.length)throw new Error("AI nie znalazło pozycji");
  return new Response(JSON.stringify(parsed),{headers:{"content-type":"application/json","cache-control":"no-store"}});
 }catch(error){
  console.error("extract-invoice",error);
  return new Response(JSON.stringify({error:error instanceof Error?error.message:"Nie udało się odczytać faktury"}),{status:500,headers:{"content-type":"application/json"}});
 }
};

export const config={path:"/.netlify/functions/extract-invoice"};
