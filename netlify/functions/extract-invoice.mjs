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
     {type:"input_text",text:"To są kolejne strony faktury. Dla każdego zdjęcia przekazane są CZTERY obrazy w tej kolejności: (1) górna połowa całej tabeli, (2) dolna połowa całej tabeli, (3) powiększenie kolumn liczbowych z górnej połowy, (4) powiększenie kolumn liczbowych z dolnej połowy. Połowy lekko na siebie zachodzą. Obrazy 3 i 4 są materiałem kontrolnym dla Ilości, Jedn.m i cen — nie są kolejnymi stronami i nie wolno z nich tworzyć dodatkowych pozycji. Zachowaj kolejność stron i nie duplikuj wierszy widocznych w zakładzie. Odczytaj tabelę WIERSZ PO WIERSZU. Kolumna Lp. jest jedynym wyznacznikiem nowej pozycji: utwórz dokładnie jeden rekord dla każdego wydrukowanego numeru Lp. Tekst bez własnego numeru Lp. jest kontynuacją nazwy wcześniejszej pozycji — połącz go z nią. Dla każdego Lp. patrz poziomo i odczytaj z tego samego wiersza pełną Nazwę towaru lub usługi, Ilość i Jedn.m. Najpierw ustal numer Lp. i poziom jego wiersza na obrazie całej tabeli, potem na powiększeniu znajdź DOKŁADNIE TEN SAM poziom. Nie pobieraj Ilości ani Jedn.m z wiersza powyżej lub poniżej. KOLUMNA ILOŚĆ WYMAGA PODWÓJNEJ KONTROLI: odczytaj ją bezpośrednio, a następnie sprawdź przy użyciu Cena jedn. brutto i Wartość brutto (Ilość × cena jednostkowa = wartość brutto). Przykład: cena 25,00 i wartość 100,00 oznaczają ilość 4; cena 25,00 i wartość 75,00 oznaczają ilość 3. W razie różnicy wybierz ilość potwierdzoną rachunkiem. Uważaj szczególnie na 3/4 i 1/2. Jednostkę również czytaj wyłącznie z komórki Jedn.m tego samego wiersza; nie wyprowadzaj jej z nazwy produktu. Nie zwracaj PKWiU, cen, wartości, netto, VAT ani brutto — służą wyłącznie do kontroli. Jeśli wartości nie da się potwierdzić, pozostaw pusty tekst zamiast zgadywać. Na końcu wykonaj drugi przebieg wyłącznie po Lp., Ilość, Jedn.m, Cena jedn. brutto i Wartość brutto oraz popraw wszystkie przesunięcia o jeden wiersz."},...documentParts
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
