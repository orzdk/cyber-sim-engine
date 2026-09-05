@echo off

pushd "%~dp0\.."
node runtime\play.js ^
  --deck1 decks\GGR_Arasaka_Compact.deck ^
  --deck2 decks\GGB_Bodyguard_Wall.deck ^
  --bot1 ..\cyber-sim-sdk\server-ai-mybot-v2.js ^
  --bot2 ..\cyber-sim-sdk\server-ai-mybot-v2.js ^
  --runcount 5000
popd
pause 