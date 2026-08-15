@echo off
REM Build Pipatab: bundle the web client, then compile the Go server.

if not exist node_modules (
    echo Installing web build tools...
    call npm install --no-audit --no-fund
    if %ERRORLEVEL% neq 0 exit /b 1
)

echo Typechecking client...
call npx tsc --noEmit
if %ERRORLEVEL% neq 0 exit /b 1

echo Bundling client...
call npm run --silent build
if %ERRORLEVEL% neq 0 exit /b 1

set VERSION=dev
for /f "delims=" %%v in ('git describe --tags --always --dirty 2^>nul') do set VERSION=%%v

echo Building server %VERSION%...
go build -trimpath -ldflags "-s -w -X main.version=%VERSION%" -o pipatab.exe .
if %ERRORLEVEL% neq 0 exit /b 1

echo Build complete: pipatab.exe (%VERSION%)
