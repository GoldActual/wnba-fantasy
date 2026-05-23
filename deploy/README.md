# Pi Deployment

Always-on hosting on a Raspberry Pi (4B+) with public read-only access via Tailscale Funnel. Coexists with Pi-hole.

## First-time deploy

On your dev box, copy the live DB up first so the league's history isn't lost:

```bash
ssh cole@<pi> 'mkdir -p ~/wnba-fantasy/backend/data'
scp backend/data/wnba.db        cole@<pi>:~/wnba-fantasy/backend/data/
scp backend/data/last_sync.json cole@<pi>:~/wnba-fantasy/backend/data/
```

Then SSH into the Pi and:

```bash
# 1. Clone
git clone <repo-url> ~/wnba-fantasy
cd ~/wnba-fantasy

# 2. Run the installer (it will prompt you to fill in .env)
bash deploy/install.sh
```

The installer creates a venv, builds the frontend, copies the systemd unit into place, and starts the service. It will pause to let you edit `.env` and paste in an admin token. Generate one with:

```bash
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
```

Once the service is up, `curl http://<pi-lan-ip>:8000/api/health` should return a 200. Open the same URL in a browser to see the UI.

## Redeploy after code changes

```bash
cd ~/wnba-fantasy
git pull
bash deploy/install.sh
sudo systemctl restart wnba-fantasy.service
```

`install.sh` is idempotent and never touches `backend/data/` or `.env`.

## Tailscale Funnel for public access

After `sudo tailscale up`:

```bash
sudo tailscale set --hostname=wnba
sudo tailscale cert wnba.<your-tailnet>.ts.net
sudo tailscale serve --bg --https=443 http://127.0.0.1:8000
sudo tailscale funnel --bg 443 on
tailscale funnel status
```

Public URL: `https://wnba.<your-tailnet>.ts.net`. Reads work without auth; writes require the admin token via Sign In.

If `funnel on` errors out: enable MagicDNS + HTTPS certs in your Tailscale admin console (DNS tab), and grant the `funnel` node attribute to this device in your ACL.

## Day-to-day

| Need | Command |
|------|---------|
| Tail live logs | `sudo journalctl -u wnba-fantasy.service -f` |
| Restart | `sudo systemctl restart wnba-fantasy.service` |
| Stop | `sudo systemctl stop wnba-fantasy.service` |
| Status + last lines | `sudo systemctl status wnba-fantasy.service` |
| Disable autostart | `sudo systemctl disable wnba-fantasy.service` |

Daily data sync fires automatically at 6am Pacific. To run one on demand, click "Sync data" in the UI (requires sign-in) or `curl -X POST -H "X-Admin-Token: $TOKEN" http://localhost:8000/api/refresh`.
