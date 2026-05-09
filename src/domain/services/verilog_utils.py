# -*- coding: utf-8 -*-
"""
Verilog 代码文本处理工具
"""

import re


def remove_comments(content: str) -> str:
    content = re.sub(r'//.*?$', '', content, flags=re.MULTILINE)
    content = re.sub(r'/\*.*?\*/', '', content, flags=re.DOTALL)
    return content
