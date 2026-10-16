// Tool choices of the MCP settings screen, kept free of React so they can be tested on their own.
import {origin} from './mcp-tokens.js';
const remembered=server=>({...server.remembered,...Object.fromEntries(server.catalog.map(tool=>[tool.name,{selected:tool.selected,readOnly:tool.readOnly,...(tool.approval===true?{approval:true}:{})}]))});
/** The tool state after the URL of a card was edited. Choices (selected, operation category, approval) are carried over only while the URL still belongs to the same origin: a same-named tool on another server is a different tool and starts from the defaults. A URL that is not complete yet changes nothing. */
export const carryTools=(server,nextUrl)=>{
 const to=origin(nextUrl);
 if(to==='')return {catalog:[],remembered:remembered(server),toolsOrigin:server.toolsOrigin};
 return to===server.toolsOrigin?{catalog:[],remembered:remembered(server),toolsOrigin:to}:{catalog:[],remembered:{},toolsOrigin:to};
};
/** Everything chosen is forgotten (the connection method changed). */
export const resetTools={catalog:[],remembered:{},toolsOrigin:''};
/** The tool list of a fresh check: tools that existed before keep their choice and operation category, new ones start unselected and as "書き込みあり". */
export const mergeCatalog=(tools,server)=>tools.map(tool=>{
 const saved=server.catalog.find(t=>t.name===tool.name)??(server.toolsOrigin===origin(server.url)?server.remembered?.[tool.name]:undefined);
 return {...tool,selected:saved?.selected??false,readOnly:saved?.readOnly??false,...(saved?.approval===true?{approval:true}:{}),hint:tool.readOnlyHint===true};
});
