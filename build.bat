@echo off
chcp 65001 >nul
title VeriFlow Build Script

echo ========================================
echo         VeriFlow Build Tool
echo ========================================
echo.

set NPM_FOUND=0
where npm >nul 2>&1
if %errorlevel% equ 0 set NPM_FOUND=1

set PYI_FOUND=0
where pyinstaller >nul 2>&1
if %errorlevel% equ 0 set PYI_FOUND=1

if %PYI_FOUND% equ 0 (
    echo [WARNING] PyInstaller not found
    echo Install: pip install pyinstaller
    echo.
)

if %NPM_FOUND% equ 0 (
    echo [WARNING] npm not found, VSIX build will be skipped
) else (
    echo [OK] npm found
)

:menu
echo.
echo Select build option:
echo.
echo   [1] Build GUI (VeriFlow.exe)
echo   [2] Build CLI (VeriFlow-cli.exe)
if %NPM_FOUND% equ 1 (
    echo   [3] Build VSIX (VS Code Extension)
)
echo   [4] Build All
echo   [Q] Quit
echo.
set /p choice="Enter option [1-4 or Q]: "

if /i "%choice%"=="1" goto build_gui
if /i "%choice%"=="2" goto build_cli
if /i "%choice%"=="3" if %NPM_FOUND% equ 1 goto build_vsix
if /i "%choice%"=="4" goto build_all
if /i "%choice%"=="Q" goto end

echo Invalid option!
goto menu

:build_gui
if %PYI_FOUND% equ 0 (
    echo.
    echo [ERROR] PyInstaller not installed
    echo Run: pip install pyinstaller
    echo.
    pause
    goto menu
)
echo.
echo Building GUI version...
pyinstaller VeriFlow.spec --noconfirm
if %errorlevel% equ 0 (
    echo.
    echo [SUCCESS] GUI build completed!
    echo Output: dist\VeriFlow.exe
    echo.
) else (
    echo.
    echo [FAILED] GUI build failed!
    echo.
)
pause
goto menu

:build_cli
if %PYI_FOUND% equ 0 (
    echo.
    echo [ERROR] PyInstaller not installed
    echo Run: pip install pyinstaller
    echo.
    pause
    goto menu
)
echo.
echo Building CLI version...
pyinstaller VeriFlow-cli.spec --noconfirm
if %errorlevel% equ 0 (
    echo.
    echo [SUCCESS] CLI build completed!
    echo Output: dist\VeriFlow-cli.exe
    echo.
) else (
    echo.
    echo [FAILED] CLI build failed!
    echo.
)
pause
goto menu

:build_vsix
echo.
echo Building VSIX version...
cd veriflow-vscode

if not exist "node_modules" (
    echo Installing npm dependencies...
    call npm install
)

echo Compiling TypeScript...
call npm run compile
if %errorlevel% neq 0 (
    echo [FAILED] TypeScript compilation failed!
    cd ..
    pause
    goto menu
)

echo Packaging VSIX...
call npm run package
cd ..

if %errorlevel% equ 0 (
    for %%f in (veriflow-vscode\*.vsix) do (
        echo.
        echo [SUCCESS] VSIX build completed!
        echo Output: %%f
        echo.
    )
) else (
    echo.
    echo [FAILED] VSIX build failed!
    echo.
)
pause
goto menu

:build_all
echo.
echo ========================================
echo         Building All Versions...
echo ========================================
echo.

if %PYI_FOUND% equ 1 (
    call :build_gui
    call :build_cli
) else (
    echo [SKIP] GUI and CLI builds (PyInstaller not found)
)

if %NPM_FOUND% equ 1 (
    call :build_vsix
) else (
    echo [SKIP] VSIX build (npm not found)
)

echo.
echo ========================================
echo         All Builds Complete!
echo ========================================
echo.
echo Output files:
if exist "dist\VeriFlow.exe" echo   - GUI:  dist\VeriFlow.exe
if exist "dist\VeriFlow-cli.exe" echo   - CLI:  dist\VeriFlow-cli.exe
for %%f in (veriflow-vscode\*.vsix) do echo   - VSIX: %%f
echo.
pause
goto menu

:end
echo.
echo Goodbye!
echo.
