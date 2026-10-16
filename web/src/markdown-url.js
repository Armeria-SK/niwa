const mcpDownload = /^\/api\/mcp\/[a-z][a-z0-9_]{0,19}\/resource\?[\x21-\x5b\x5d-\x7e]*$/;
/** External links are https? only. The sole same-origin link is an MCP resource download (the server checks login and conversation). */
export const safeUrl = value => /^https?:\/\//i.test(value) || (mcpDownload.test(value) && !value.includes('//')) ? value : '';
