const schema={
 type:"object",additionalProperties:false,required:["items"],properties:{
  items:{type:"array",items:{type:"object",additionalProperties:false,required:["lp","name","quantity","unit"],properties:{
   lp:{type:"integer"},name:{type:"string"},quantity:{type:"string"},unit:{type:"string"}
  }}}
 }
};

export default async(req)=>{
 if(req.method!=="POST")return new Response(JSON.stringify({error:"Method not allowed"}),{status:405,headers:{"content-type":"application/json"}});
 const apiKey=Netlify.env.get("OPENAI_API_KEY");
 if(!apiKey)return new Response(JSON.stringify({error:"Brak konfiguracji OPENAI_API_KEY"}),{status:500,headers:{"content-type":"application/json"}});
 try{
  const {dataUrl,mimeType,fileName}=await req.json();
  if(typeof dataUrl!=="string"||!dataUrl.startsWith("data:"))throw new Error("Nieprawidłowy plik");
  const documentPart=mimeType==="application/pdf"
   ?{type:"input_file",filename:fileName||"faktura.pdf",file_data:dataUrl}
   :{type:"input_image",image_url:dataUrl,detail:"high"};
  const response=await fetch("https://api.openai.com/v1/responses",{
   method:"POST",headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},
   body:JSON.stringify({
    model:"gpt-5-mini",
    input:[{role:"user",content:[
     {type:"input_text",text:"Odczytaj tabelę pozycji ze wszystkich stron tej polskiej faktury. Zwróć KAŻDY wiersz kolejno od pierwszej pozycji do ostatniej. Potrzebne są wyłącznie: Lp., pełna nazwa towaru lub usługi, ilość oraz jednostka miary. Łącz nazwy zawinięte do kolejnej linii. Nie przepisuj symbolu PKWiU, cen, wartości, VAT ani podatku. Nie pomijaj pozycji. Gdy pojedyncze pole jest nieczytelne, zwróć pusty tekst dla tego pola zamiast przesuwać dane między wierszami. Jednostki zapisuj np. szt., kpl., mb, kg, l."},
     documentPart
    ]}],
    text:{format:{type:"json_schema",name:"invoice_items",strict:true,schema}}
   })
  });
  const result=await response.json();
  if(!response.ok)throw new Error(result?.error?.message||"Błąd OpenAI API");
  const outputText=result.output_text||result.output?.flatMap(block=>block.content||[]).find(part=>part.type==="output_text")?.text;
  if(!outputText)throw new Error("AI nie zwróciło danych");
  const parsed=JSON.parse(outputText);
  return new Response(JSON.stringify(parsed),{headers:{"content-type":"application/json","cache-control":"no-store"}});
 }catch(error){
  console.error("extract-invoice",error);
  return new Response(JSON.stringify({error:error instanceof Error?error.message:"Nie udało się odczytać faktury"}),{status:500,headers:{"content-type":"application/json"}});
 }
};

export const config={path:"/.netlify/functions/extract-invoice"};
