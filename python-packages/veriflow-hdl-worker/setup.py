from setuptools import Distribution, setup
from setuptools.command.bdist_wheel import bdist_wheel


class WindowsPlatformDistribution(Distribution):
    def has_ext_modules(self) -> bool:
        return True


class WindowsPlatformWheel(bdist_wheel):
    def finalize_options(self) -> None:
        super().finalize_options()
        self.root_is_pure = False
        self.python_tag = "py3"
        self.plat_name = "win_amd64"
        self.plat_name_supplied = True

    def get_tag(self):
        return "py3", "none", "win_amd64"


setup(
    cmdclass={"bdist_wheel": WindowsPlatformWheel},
    distclass=WindowsPlatformDistribution,
)
