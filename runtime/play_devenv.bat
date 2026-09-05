@echo off

pushd "%~dp0\.."
node runtime\play.js ^
  --deck2 decks\GGR_Arasaka_Compact.deck ^
  --deck1 decks\GGB_Bodyguard_Wall.deck ^
  --bot1 ..\bsdk\server-ai-mybot-v2.js ^
  --bot2 ..\bsdk\server-ai-mybot-v2.js ^
  --runcount 5000
popd
pause 