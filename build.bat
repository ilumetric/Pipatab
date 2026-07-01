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

echo Building server...
go build -ldflags "-s -w" -o pipatab.exe .
if %ERRORLEVEL% neq 0 exit /b 1

echo Build complete: pipatab.exe
