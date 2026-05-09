# -*- coding: utf-8 -*-
"""
文件服务 - 提供统一的文件读写功能
"""

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional, List


class IFileService(ABC):
    """文件服务接口"""

    @abstractmethod
    def read_text(self, filepath: str, encodings: Optional[List[str]] = None) -> str:
        """读取文本文件，自动检测编码"""
        pass

    @abstractmethod
    def write_text(self, filepath: str, content: str, encoding: str = 'utf-8') -> None:
        """写入文本文件"""
        pass

    @abstractmethod
    def read_binary(self, filepath: str) -> bytes:
        """读取二进制文件"""
        pass

    @abstractmethod
    def file_exists(self, filepath: str) -> bool:
        """检查文件是否存在"""
        pass

    @abstractmethod
    def get_filename(self, filepath: str) -> str:
        """获取文件名（不含路径）"""
        pass

    @abstractmethod
    def list_files(self, directory: str, patterns: Optional[List[str]] = None) -> List[Path]:
        """递归列出匹配模式的文件"""
        pass

    @abstractmethod
    def find_file(self, filename: str, search_dirs: List[str]) -> Optional[Path]:
        """在搜索目录中查找文件"""
        pass


class FileService(IFileService):
    """文件服务实现"""

    DEFAULT_ENCODINGS = ['utf-8', 'utf-8-sig', 'latin-1', 'cp1252', 'gbk', 'gb2312']
    VERILOG_PATTERNS = ['*.v', '*.sv', '*.vh', '*.svh']

    def read_text(self, filepath: str, encodings: Optional[List[str]] = None) -> str:
        path = Path(filepath)
        if not path.exists():
            raise FileNotFoundError(f"File not found: {filepath}")

        encodings = encodings or self.DEFAULT_ENCODINGS

        for encoding in encodings:
            try:
                return path.read_text(encoding=encoding)
            except (UnicodeDecodeError, UnicodeError):
                continue

        return path.read_bytes().decode('utf-8', errors='ignore')

    def write_text(self, filepath: str, content: str, encoding: str = 'utf-8') -> None:
        Path(filepath).write_text(content, encoding=encoding)

    def read_binary(self, filepath: str) -> bytes:
        return Path(filepath).read_bytes()

    def file_exists(self, filepath: str) -> bool:
        return Path(filepath).exists()

    def get_filename(self, filepath: str) -> str:
        return Path(filepath).name

    def list_files(self, directory: str, patterns: Optional[List[str]] = None) -> List[Path]:
        if patterns is None:
            patterns = self.VERILOG_PATTERNS

        dir_path = Path(directory)
        if not dir_path.exists():
            return []

        results = []
        for pattern in patterns:
            results.extend(dir_path.rglob(pattern))
        return sorted(set(results), key=lambda p: p.name)

    def find_file(self, filename: str, search_dirs: List[str]) -> Optional[Path]:
        for search_dir in search_dirs:
            for pattern in self.VERILOG_PATTERNS:
                for candidate in Path(search_dir).rglob(pattern):
                    if candidate.name == filename:
                        return candidate
        return None
