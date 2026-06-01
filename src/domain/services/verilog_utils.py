# -*- coding: utf-8 -*-
"""
Verilog 代码文本处理工具
"""

import re
from typing import Optional, Set


def remove_comments(content: str) -> str:
    content = re.sub(r'//.*?$', '', content, flags=re.MULTILINE)
    content = re.sub(r'/\*.*?\*/', '', content, flags=re.DOTALL)
    return content


def preprocess_verilog(content: str, defines: Optional[Set[str]] = None) -> str:
    """Evaluate common Verilog conditional-compilation directives."""
    active_defines = set(defines or set())
    output = []
    stack = []

    def parent_active() -> bool:
        return all(frame["active"] for frame in stack[:-1])

    def current_active() -> bool:
        return all(frame["active"] for frame in stack)

    def macro_name(rest: str) -> str:
        match = re.match(r'([A-Za-z_]\w*)', rest.strip())
        return match.group(1) if match else ""

    for line in content.splitlines(keepends=True):
        stripped = line.lstrip()
        directive = re.match(r'`(ifdef|ifndef|elsif|else|endif|define|undef)\b(.*)', stripped)
        if not directive:
            output.append(line if current_active() else "\n")
            continue

        kind = directive.group(1)
        rest = directive.group(2)
        name = macro_name(rest)

        if kind in ("ifdef", "ifndef"):
            outer = current_active()
            condition = name in active_defines
            if kind == "ifndef":
                condition = not condition
            branch_active = outer and condition
            stack.append({
                "outer": outer,
                "active": branch_active,
                "taken": branch_active,
            })
            output.append("\n")
        elif kind == "elsif":
            if stack:
                frame = stack[-1]
                condition = name in active_defines
                branch_active = frame["outer"] and not frame["taken"] and condition
                frame["active"] = branch_active
                frame["taken"] = frame["taken"] or branch_active
            output.append("\n")
        elif kind == "else":
            if stack:
                frame = stack[-1]
                branch_active = frame["outer"] and not frame["taken"]
                frame["active"] = branch_active
                frame["taken"] = True
            output.append("\n")
        elif kind == "endif":
            if stack:
                stack.pop()
            output.append("\n")
        elif kind == "define":
            if current_active() and name:
                active_defines.add(name)
            output.append("\n")
        elif kind == "undef":
            if current_active() and name:
                active_defines.discard(name)
            output.append("\n")

    return ''.join(output)
