"""
PoC 统一 CLI 入口 —— 打包为单可执行文件后供 Electron child_process 调用。
用法：
  pptx_cli modify <in.pptx> <out.pptx>
  pptx_cli verify <path.pptx>
输出：stdout 单行 JSON，供 Node 侧 JSON.parse。
"""
import sys
import json

from poc_modify import modify
from verify import verify


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing command"}))
        sys.exit(2)
    cmd = sys.argv[1]
    try:
        if cmd == "modify":
            r = modify(sys.argv[2], sys.argv[3])
        elif cmd == "verify":
            r = verify(sys.argv[2])
        else:
            print(json.dumps({"error": f"unknown command: {cmd}"}))
            sys.exit(2)
        print(json.dumps(r, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e), "type": type(e).__name__}))
        sys.exit(1)


if __name__ == "__main__":
    main()
