#!/bin/bash
# Login-node setup for HoldUp Bridge builds: downloads + extraction only (no builds).
set -euo pipefail
mkdir -p ~/tools ~/android-sdk/cmdline-tools
cd ~/tools

if [ ! -x ~/tools/jdk17/bin/java ]; then
  echo "== JDK 17"
  curl -fsSL -o jdk17.tar.gz 'https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse'
  mkdir -p jdk17 && tar xzf jdk17.tar.gz -C jdk17 --strip-components=1 && rm jdk17.tar.gz
fi
export JAVA_HOME=~/tools/jdk17
export PATH=$JAVA_HOME/bin:$PATH
java -version 2>&1 | head -1

if [ ! -x ~/android-sdk/cmdline-tools/latest/bin/sdkmanager ]; then
  echo "== cmdline-tools"
  curl -fsSL -o cmdline-tools.zip 'https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip'
  rm -rf ~/android-sdk/cmdline-tools/latest ~/tools/ct_extract
  python3 -I -m zipfile -e cmdline-tools.zip ~/tools/ct_extract
  mv ~/tools/ct_extract/cmdline-tools ~/android-sdk/cmdline-tools/latest
  chmod +x ~/android-sdk/cmdline-tools/latest/bin/*
  rm -rf cmdline-tools.zip ~/tools/ct_extract
fi

echo "== SDK packages"
SDKM=~/android-sdk/cmdline-tools/latest/bin/sdkmanager
yes | $SDKM --sdk_root=$HOME/android-sdk --licenses > /dev/null || true
$SDKM --sdk_root=$HOME/android-sdk "platforms;android-36" "build-tools;35.0.0" "build-tools;36.0.0" 2>&1 | grep -v '^\[' | tail -5
ls ~/android-sdk ~/android-sdk/platforms ~/android-sdk/build-tools
du -sh ~/tools ~/android-sdk
echo SETUP_DONE
