from hashlib import sha256
from pathlib import Path
import sys


EXPECTED_SHA256 = "d229472a608c89521175885a7ffae0bdd305434216d63c70427ac99a0b1ec052"


def replace_exact(source: str, old: str, new: str, count: int = 1) -> str:
    if source.count(old) != count:
        raise ValueError(f"Expected {count} occurrences, found {source.count(old)}: {old[:70]}")
    return source.replace(old, new)


source_path = Path(sys.argv[1])
destination_path = Path(sys.argv[2])
original = source_path.read_bytes()
if sha256(original).hexdigest() != EXPECTED_SHA256:
    raise ValueError("Renderer bundle does not match Twenty v2.45.6 local image")

source = original.decode()
source = replace_exact(
    source,
    'e.clipboardData={types:n===``?[]:[`text/plain`],getData:e=>nn.has(e)?n:``,setData:()=>void 0}',
    'e.clipboardData={types:[...(n===``?[]:[`text/plain`]),...(t.transferFiles?.length?[`Files`]:[])],files:t.transferFiles??[],getData:e=>nn.has(e)?n:``,setData:()=>void 0}',
    count=2,
)
source = replace_exact(
    source,
    'rn(e,t)};var sn=',
    'rn(e,t),t.type===`drop`&&Object.defineProperty(e,`dataTransfer`,{value:{files:t.transferFiles??[]},configurable:!0,enumerable:!0})};var sn=',
    count=2,
)
source = replace_exact(
    source,
    'mA=(e,t)=>{if(e.type!=="paste")return;let n=t.clipboardData;if(!(0,D.isObject)(n))return;let i=n.getData;if(!(0,D.isFunction)(i))return;let a=i.call(n,"text");(0,D.isString)(a)&&(e.clipboardText=a.slice(0,Ab))}',
    'mA=(e,t)=>{if(e.type==="paste"){let n=t.clipboardData;if(!(0,D.isObject)(n))return;let i=n.getData;if((0,D.isFunction)(i)){let a=i.call(n,"text");(0,D.isString)(a)&&(e.clipboardText=a.slice(0,Ab))}let a=yA(n.files);a?.length&&(e.transferFiles=a)}else if(e.type==="drop"){let n=t.dataTransfer;if(!(0,D.isObject)(n))return;let i=yA(n.files);i?.length&&(e.transferFiles=i)}}',
)
source = replace_exact(
    source,
    'let a=t[i];if(!(0,D.isObject)(a))continue;let o=a;',
    'let a=t[i];if(a instanceof File){n.push(a);continue}if(!(0,D.isObject)(a))continue;let o=a;',
)
destination_path.write_text(source)
print(f"Patched {destination_path} ({sha256(destination_path.read_bytes()).hexdigest()})")
