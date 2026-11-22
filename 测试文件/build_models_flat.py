#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 models/子目录 里的模型文件“平铺”复制到 models/ 根目录，
避免部分 Apache 配置拒绝访问子目录导致的 HTTP 403。

用法（在工作区 CasioEmuMsvcWeb 目录下执行）：
    python3 build_models_flat.py

生成的平铺文件命名规则：
    models/fx991cnx_VerF/config.bin  ->  models/fx991cnx_VerF__config.bin
同时重写 models/manifest.json 的 dir/files 字段指向平铺文件。
"""
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(ROOT, "models")
MANIFEST = os.path.join(MODELS, "manifest.json")

SKIP_NAMES = {"_disas.txt"}          # 反汇编文本，运行时不需要
SKIP_EXT = {".txt", ".md", ".log"}   # 大文本一律不参与前端加载


def main():
    if not os.path.isfile(MANIFEST):
        sys.exit("找不到 models/manifest.json")

    with open(MANIFEST, encoding="utf-8") as f:
        mf = json.load(f)

    changed = False
    for item in mf.get("models", []):
        sub = item.get("dir", "")
        if not sub:
            continue
        abs_sub = os.path.join(ROOT, sub.replace("/", os.sep))
        if not os.path.isdir(abs_sub):
            print(f"[skip] 目录不存在：{sub}")
            continue
        if os.path.normpath(abs_sub) == os.path.normpath(MODELS):
            print(f"[skip] {sub} 已是根目录")
            continue

        prefix = os.path.basename(abs_sub)          # 例如 fx991cnx_VerF
        new_files = []

        # 以清单声明为准；清单没写就扫描目录
        declared = item.get("files") or []
        if declared:
            names = [d["name"] for d in declared]
        else:
            names = sorted(os.listdir(abs_sub))

        for nm in names:
            if nm in SKIP_NAMES:
                continue
            if os.path.splitext(nm)[1].lower() in SKIP_EXT:
                continue
            src = os.path.join(abs_sub, nm)
            if not os.path.isfile(src):
                print(f"  [miss] {sub}/{nm}")
                continue
            flat_name = f"{prefix}__{nm}"
            dst = os.path.join(MODELS, flat_name)
            shutil.copy2(src, dst)
            size = os.path.getsize(dst)
            print(f"  [copy] {sub}/{nm}  ->  models/{flat_name}  ({size} B)")

            orig = next((d for d in declared if d["name"] == nm), None)
            new_files.append({
                "name": flat_name,
                "required": (orig or {}).get("required", nm in ("config.bin", "rom.bin")),
                "desc": (orig or {}).get("desc", ""),
            })

        if new_files:
            item["dir"] = "models"          # 平铺后基准就是 models 根
            item["files"] = new_files
            item["flat"] = True
            changed = True

    if changed:
        mf["flat_mode"] = True
        with open(MANIFEST, "w", encoding="utf-8") as f:
            json.dump(mf, f, ensure_ascii=False, indent=2)
        print("\n[ok] manifest.json 已更新为平铺模式")
    else:
        print("\n[info] 无需改动")


if __name__ == "__main__":
    main()
