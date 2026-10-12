'use strict';
// Typed frames preserve undefined cells, Set/Map and non-finite schema
// bounds. Ordinary JSON would turn missing array slots into null. Every array
// and object is framed, so authored keys cannot collide with a sentinel.
function encode(value) {
    if(value===undefined)return ['u'];
    if(typeof value==='number'&&!Number.isFinite(value))return ['n',String(value)];
    if(value===null||typeof value!=='object')return value;
    if(Array.isArray(value))return ['a',Array.from(value,encode)];
    if(value instanceof Set)return ['s',Array.from(value,encode)];
    if(value instanceof Map)return ['m',Array.from(value,([k,v])=>[encode(k),encode(v)])];
    if(value instanceof Date)return ['d',value.toISOString()];
    return ['o',Object.entries(value).map(([k,v])=>[k,encode(v)])];
}
function decode(value) {
    if(!Array.isArray(value))return value;
    const [type,data]=value;
    switch(type){
        case 'u':return undefined;
        case 'n':return Number(data);
        case 'a':return data.map(decode);
        case 's':return new Set(data.map(decode));
        case 'm':return new Map(data.map(([k,v])=>[decode(k),decode(v)]));
        case 'd':return new Date(data);
        case 'o':return Object.fromEntries(data.map(([k,v])=>[k,decode(v)]));
        default:throw new Error('Invalid frozen fixture frame');
    }
}
module.exports={encode,decode};
