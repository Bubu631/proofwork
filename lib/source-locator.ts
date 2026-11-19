/* Locate only defensible text spans in the simulated source. Never use synthetic boxes as real coordinates. */
export function locateSource(text:string,ev:any):{start:number,length:number,matched:string}|null{
 if(!ev)return null;
 const candidates=[ev.text_as_read];
 if(typeof ev.value==='number') candidates.push(new Intl.NumberFormat('en-US',{minimumFractionDigits:ev.value_type==='money'?2:0,maximumFractionDigits:6}).format(ev.value),new Intl.NumberFormat('en-US',{maximumFractionDigits:6}).format(ev.value));
 const needles=[...new Set(candidates.filter((n:any)=>typeof n==='string'&&n.length))] as string[];
 const find=(hay:string,offset=0,from=0,unique=true)=>{for(const n of needles){const matches:number[]=[];let pos=hay.indexOf(n,from);while(pos>=0){const numeric=/^[\d,.-]+$/.test(n);if(!numeric||(!/[\d.,]/.test(hay[pos-1]||'')&&!/^(?:\d|[.,]\d)/.test(hay.slice(pos+n.length))))matches.push(pos);pos=hay.indexOf(n,pos+Math.max(n.length,1));}if(matches.length&&(!unique||matches.length===1))return{start:offset+matches[0],length:n.length,matched:n};}return null};
 const lot=String(ev.field||'').match(/^([A-Z]+-?\d+)_(adjusted_basis|proceeds|basis|wash|acquired|sold|quantity|ordinary)/i);
 if(lot){const hit=new RegExp('\\b'+lot[1]+'\\b').exec(text);if(!hit)return null;const tail=text.slice(hit.index);const next=/\b[Ll]ot\s+[A-Z]+-?\d+\b/.exec(tail.slice(lot[1].length));const row=tail.slice(0,next?lot[1].length+next.index:undefined);const markers:Record<string,string[]>={proceeds:['proceeds'],adjusted_basis:['adjusted basis'],ordinary:['ordinary income'],basis:['basis'],wash:['wash sale loss disallowed','wash sale'],acquired:['acquired'],sold:['sold'],quantity:[lot[1]]};const marker=(markers[lot[2]]||[]).find(m=>row.toLowerCase().includes(m.toLowerCase()));if(!marker)return null;const from=row.toLowerCase().indexOf(marker.toLowerCase())+marker.length;return find(row,text.indexOf(row),from,false);}
 if(ev.field==='page_total'){const from=text.toLowerCase().lastIndexOf('page total');return from>=0?find(text,0,from):null;}
 const trip=String(ev.field||'').match(/^trip(\d+)_(date|destination|purpose|miles)$/);if(trip){const rows=text.split(/;|\n/).filter(r=>/\d{4}-\d{2}-\d{2}/.test(r));const row=rows[Number(trip[1])-1];return row?find(row,text.indexOf(row)):null;}
 return find(text);
}
