@echo off
chcp 65001 > nul
echo.
echo  Claude Code Monitor — 동기화 시작
echo  ─────────────────────────────────
echo.

:: 1. 사용량 파싱
echo [1/4] 사용량 데이터 파싱 중...
node scripts\parse-usage.js
if %ERRORLEVEL% NEQ 0 ( echo 실패: parse-usage.js & exit /b 1 )

:: 2. AI 인사이트 생성 (ANTHROPIC_API_KEY 있을 때만)
if defined ANTHROPIC_API_KEY (
  echo [2/4] AI 인사이트 생성 중...
  node scripts\generate-insights.js
  if %ERRORLEVEL% NEQ 0 ( echo 경고: 인사이트 생성 실패 - 데이터만 업데이트합니다 )
) else (
  echo [2/4] ANTHROPIC_API_KEY 미설정 — 인사이트 건너뜀
)

:: 3. git 커밋
echo [3/4] 변경사항 커밋 중...
git add docs\data.json docs\insights.json 2>nul
for /f "tokens=*" %%i in ('powershell -command "Get-Date -Format 'yyyy-MM-dd HH:mm'"') do set NOW=%%i
git commit -m "sync: %NOW%"
if %ERRORLEVEL% NEQ 0 ( echo 변경사항 없음 - 이미 최신 상태입니다 & goto done )

:: 4. push
echo [4/4] GitHub 에 푸시 중...
git push
if %ERRORLEVEL% NEQ 0 ( echo 실패: git push & exit /b 1 )

:done
echo.
echo  ✅ 동기화 완료! 잠시 후 GitHub Pages 에서 확인하세요.
echo.
pause
