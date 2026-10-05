# torwatch deploy (linux/arm64)

Build + stage on your workstation:

```sh
sh deploy/build-arm64.sh          # stages into ./dist
file dist/torwatchd               # expect: ELF 64-bit LSB, ARM aarch64
```

Install on the host (one time):

```sh
sudo useradd -r -s /usr/sbin/nologin torwatch
sudo mkdir -p /opt/torwatch /var/lib/torwatch /etc/torwatch
sudo cp dist/torwatchd /opt/torwatch/
sudo cp -r dist/static /opt/torwatch/
sudo chown -R torwatch:torwatch /opt/torwatch /var/lib/torwatch
# secrets: Basic auth (strongly recommended — without it anyone can make
# this host download any torrent) and the optional OpenSubtitles key:
printf 'TORWATCH_AUTH=user:password\nOPENSUBTITLES_API_KEY=...\n' | sudo tee /etc/torwatch/env
sudo chmod 600 /etc/torwatch/env
sudo cp deploy/torwatchd.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now torwatchd
```
