@echo off
REM Build Pipatab: compile TypeScript then Go

echo Compiling TypeScript...
call tsc
if %ERRORLEVEL% neq 0 (
    echo TypeScript compilation failed.
    exit /b 1
)

echo Building Go binary...
go build -o pipatab.exe .
if %ERRORLEVEL% neq 0 (
    echo Go build failed.
    exit /b 1
)

echo Build complete: pipatab.exe
