// Read-only production probes; generated documents stay in container memory.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readInstallation} from '../../dist/config/installation.js';
import {configuredPackageExecutor} from '../../dist/tools/packages/client.js';
import {configuredProgramExecutor} from '../../dist/sandbox/client.js';
import './wait-executors.mjs';
const root='/home/niwa/niwa',config=readInstallation(root),socket=`${root}/runtime/sockets/program.sock`;
const packages=configuredPackageExecutor(socket,config.programExecutorUid),list=await packages.list();
for(const name of ['python3-pil','python3-reportlab','python3-openpyxl','fonts-noto-cjk']) assert.ok(list.installed.some(item=>item.name===name));
assert.ok(!list.available.some(item=>item.name==='niwa-acceptance'));
const execute=configuredProgramExecutor(socket,config.programExecutorUid),id=`production-probe-${randomUUID()}`;
const input={operation_id:id,agent_id:'local-acceptance',room_id:'local-acceptance',task_id:id,allow_start:true,seconds:30,command:['/usr/bin/python3','-c',`import io,os,zipfile
from PIL import Image,ImageDraw,ImageFont
from reportlab.pdfgen import canvas
from openpyxl import Workbook,load_workbook
assert os.getuid()!=0
font=ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',24)
im=Image.new('RGB',(400,80),'white');ImageDraw.Draw(im).text((10,10),'制作テスト',font=font,fill='black');b=io.BytesIO();im.save(b,format='PNG');b.seek(0);assert Image.open(b).size==(400,80)
pdf=io.BytesIO();c=canvas.Canvas(pdf);c.drawString(20,20,'Production document acceptance');c.save();assert pdf.getvalue().startswith(b'%PDF-')
w=Workbook();w.active['A1']='検証';w.active['B1']=42;x=io.BytesIO();w.save(x);x.seek(0);assert load_workbook(x).active['B1'].value==42
print('PASS: nonroot PNG with Japanese font, PDF and XLSX generation/readback')`]};
const result=await execute(input);assert.equal(result.code,0,result.stderr ?? result.error);console.log(result.stdout.trim());
assert.deepEqual(await execute({...input,allow_start:false}),result);
console.log(`PASS: production package IPC (${list.installed.length} installed), artifact generation and durable result reuse`);
