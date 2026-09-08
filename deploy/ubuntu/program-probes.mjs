// Python snippets run only with artificial files during explicit operator acceptance.
export const securityProbe = `status=dict(line.split(':',1) for line in pathlib.Path('/proc/self/status').read_text().splitlines() if ':' in line)
assert status['NoNewPrivs'].strip()=='1' and status['Seccomp'].strip()=='2'`;

export function diskProbe(directory) {
  return `import errno,os,tempfile
directory=${JSON.stringify(directory)}
fs=os.statvfs(directory)
size=fs.f_blocks*fs.f_frsize
fd,path=tempfile.mkstemp(prefix='niwa-enospc-',dir=directory)
try:
 try: os.posix_fallocate(fd,0,size+fs.f_frsize)
 except OSError as error: assert error.errno==errno.ENOSPC,error
 else: raise AssertionError('filesystem capacity did not reject oversized allocation')
finally:
 os.close(fd); os.unlink(path)
print('PASS: ENOSPC boundary',size)`;
}

export const pidProbe = `import errno,os,signal,time
children=[]
try:
 try:
  for i in range(96):
   pid=os.fork()
   if pid==0: time.sleep(60); os._exit(0)
   children.append(pid)
 except OSError as error: assert error.errno==errno.EAGAIN,error
 else: raise AssertionError('PID limit was not enforced')
 assert 0<len(children)<64
finally:
 for pid in children:
  try: os.kill(pid,signal.SIGKILL)
  except ProcessLookupError: pass
 for pid in children: os.waitpid(pid,0)
print('PASS: PID creation limit')`;
