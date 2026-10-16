// Tool choices of the MCP settings screen, kept free of React so they can be tested on their own.
/** What was chosen for each tool name, including choices remembered from before the list was cleared (an edited URL). */
export const rememberTools=server=>({...server.remembered,...Object.fromEntries(server.catalog.map(tool=>[tool.name,{selected:tool.selected,readOnly:tool.readOnly,...(tool.approval===true?{approval:true}:{})}]))});
/** The tool list of a fresh check: tools that existed before keep their choice and operation category, new ones start unselected. */
export const mergeCatalog=(tools,server)=>tools.map(tool=>{
 const saved=server.catalog.find(t=>t.name===tool.name)??server.remembered?.[tool.name];
 return {...tool,selected:saved?.selected??false,readOnly:saved?.readOnly??false,...(saved?.approval===true?{approval:true}:{}),hint:tool.readOnlyHint===true};
});
