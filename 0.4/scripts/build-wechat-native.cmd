@echo off
setlocal
rem Run in an x64 Visual Studio Developer Command Prompt. No downloads or injection.
rem Args: directory containing json.hpp, directory containing httplib.h
if "%~1"=="" exit /b 2
if "%~2"=="" exit /b 2
if not exist "%~1\json.hpp" exit /b 3
if not exist "%~2\httplib.h" exit /b 3
where cl.exe >nul 2>nul
if errorlevel 1 exit /b 4
set "QAWX_ROOT=%~dp0.."
if not exist "%QAWX_ROOT%\runtime\wechat-native" mkdir "%QAWX_ROOT%\runtime\wechat-native"
pushd "%QAWX_ROOT%\runtime\wechat-native"
cl /nologo /O2 /MT /EHsc /std:c++17 /utf-8 /DNOMINMAX /LD /I"%~1" /I"%~2" "%QAWX_ROOT%\src\wechat-native\NativeMentionBackend.cpp" /link version.lib ws2_32.lib /out:NativeMentionBackend-4.1.15.13-r5.dll
if errorlevel 1 goto failed
cl /nologo /O2 /MT /EHsc /std:c++17 /utf-8 /DNOMINMAX "%QAWX_ROOT%\src\wechat-native\NativeMentionLoader.cpp" /link /out:NativeMentionLoader.exe
if errorlevel 1 goto failed
popd
exit /b 0
:failed
popd
exit /b 1
