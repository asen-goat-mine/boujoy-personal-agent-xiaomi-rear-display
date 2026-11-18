const compact=value=>String(value??'').normalize('NFKC').replace(/\s+/g,'');
export function authorizedSearchText(value,query){
 const text=compact(value),source=compact(query);
 return text.length>=2&&text.length<=80&&source.includes(text);
}
