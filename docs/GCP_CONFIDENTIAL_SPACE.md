# Running the enclave on GCP Confidential Space

Real attestation instead of the simulated path. Flare have said twice in writing
that this is not required for the bounties — so this is here because it is worth
doing on its own terms, not because judging needs it.

What changes: `MODE=0` and `SIMULATED_TEE=false` make the node fetch an
attestation token from the Confidential Space launcher rather than producing one
itself. The `register-tee` flow then registers a machine whose code hash a data
provider can actually verify.

---

## What it costs, honestly

A `c3-standard-4` runs roughly $0.15/hour, so leaving it up for the rest of the
program is about $50. Budget half a day the first time — most of it is IAM and
image permissions, not our code.

---

## 0. Before anything

```bash
gcloud auth login
gcloud config set project <PROJECT_ID>
gcloud services enable \
  compute.googleapis.com \
  confidentialcomputing.googleapis.com \
  artifactregistry.googleapis.com
```

Confidential Space needs a **TDX-capable zone**. `us-central1-a`,
`europe-west4-a` and `asia-southeast1-b` all have C3 with TDX; check with:

```bash
gcloud compute machine-types describe c3-standard-4 --zone=<ZONE>
```

---

## 1. Push the image where the VM can read it

The workload image must live in Artifact Registry, and the VM's service account
must be able to pull it. This is the step that goes wrong.

```bash
gcloud artifacts repositories create buta \
  --repository-format=docker --location=<REGION>

gcloud auth configure-docker <REGION>-docker.pkg.dev

# Reproducible: the same SOURCE_DATE_EPOCH gives the same digest, which is what
# makes the code hash on-chain mean anything.
SDE=$(git log -1 --format=%ct)
docker build --build-arg NETWORK=coston2 --build-arg SOURCE_DATE_EPOCH=$SDE \
  -t <REGION>-docker.pkg.dev/<PROJECT_ID>/buta/extension-tee:$(git rev-parse --short HEAD) .
docker push <REGION>-docker.pkg.dev/<PROJECT_ID>/buta/extension-tee:$(git rev-parse --short HEAD)
```

**Record the digest.** `docker inspect --format='{{index .RepoDigests 0}}'` — the
code hash registered on-chain derives from the image, so a tag that moves is a
machine whose attestation stops matching.

---

## 2. A service account that can pull, and nothing else

```bash
gcloud iam service-accounts create buta-tee \
  --display-name="Buta Confidential Space workload"

gcloud artifacts repositories add-iam-policy-binding buta \
  --location=<REGION> \
  --member="serviceAccount:buta-tee@<PROJECT_ID>.iam.gserviceaccount.com" \
  --role=roles/artifactregistry.reader

# Required for the launcher to mint attestation tokens.
gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member="serviceAccount:buta-tee@<PROJECT_ID>.iam.gserviceaccount.com" \
  --role=roles/confidentialcomputing.workloadUser
```

---

## 3. The VM

```bash
gcloud compute instances create buta-tee \
  --zone=<ZONE> \
  --machine-type=c3-standard-4 \
  --confidential-compute-type=TDX \
  --maintenance-policy=TERMINATE \
  --shielded-secure-boot \
  --image-family=confidential-space-debian-12 \
  --image-project=confidential-space-images \
  --service-account=buta-tee@<PROJECT_ID>.iam.gserviceaccount.com \
  --scopes=cloud-platform \
  --metadata="^~^tee-image-reference=<REGION>-docker.pkg.dev/<PROJECT_ID>/buta/extension-tee@sha256:<DIGEST>\
~tee-container-log-redirect=true\
~tee-env-MODE=0\
~tee-env-SIMULATED_TEE=false\
~tee-env-CHAIN_ID=114\
~tee-env-CHAIN_URL=https://coston2-api.flare.network/ext/C/rpc\
~tee-env-INITIAL_OWNER=0x100158159dD923E6009a1eD56fB2e8b2347aF42f\
~tee-env-EXTENSION_ID=0x000000000000000000000000000000000000000000000000000000000001006a\
~tee-env-PROXY_URL=http://<EXT_PROXY_INTERNAL_IP>:6663"
```

Three things that bite here:

- **`tee-env-` only works for variables the image's launch policy allows.** The
  Dockerfile declares them via the `tee.launch_policy.allow_env_override` label.
  If a variable is not on that list the launcher ignores it silently, which
  looks exactly like the value being wrong.
- **`CHAIN_ID` is on that list for a reason.** Without it the node fails every
  signature inside `signer.ChainID()`, and the proxy reports it as "signature
  must be 65 bytes, got 0" — a message about the proxy, for a fault in the node.
  This cost an afternoon locally; it will cost more on a VM you cannot attach to.
- **Pin by digest, not tag.** The attested code hash comes from the image.

---

## 4. The proxy stays where it is

Only the enclave needs Confidential Space. `ext-proxy` is a plain VM (or your
laptop) — it holds no secret worth attesting, and it needs the indexer database
which is reachable from anywhere.

`docker/gcp-coston2/gcp-ext-proxy/` has that side. Keep the proxy's
`PROXY_PRIVATE_KEY` off the scaffold default, as locally: it is written on-chain
as the machine's proxy id, and the availability check is verified against it.

---

## 5. Register the attested machine

The machine is new — different key, therefore different `teeId`. It is a
registration, not an update.

```bash
EXT_PROXY_URL=http://<proxy>:6664 \
EXT_PROXY_HOST_URL=https://<public-hostname> \
NORMAL_PROXY_URL=https://tee-proxy-coston2-1.flare.rocks \
SIMULATED_TEE=false \
REGISTER_COMMAND=rRap \
  ./scripts/post-build.sh
```

Then the three reads that decide whether it took:

```bash
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getTeeMachine(address)((address,address,string))" <newTeeId> --rpc-url <RPC>
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getTeeMachineStatus(address)(uint8)" <newTeeId> --rpc-url <RPC>   # 2 = PRODUCTION
node scripts/onchain-status.mjs
```

---

## 6. When it does not work

- **Container never starts, no logs.** The service account cannot pull. Check
  the Artifact Registry binding, and that you referenced a digest that exists.
- **Starts, then exits immediately.** Almost always a `tee-env-` variable the
  launch policy does not allow. `gcloud compute instances get-serial-port-output
  buta-tee --zone=<ZONE>` shows the launcher's own complaint.
- **Runs, but every signature is empty.** `CHAIN_ID`. See above.
- **Registers, then availability 404s.** The host URL on-chain is not reachable
  from a data provider. Same failure as locally, same fix —
  `scripts/update-machine-url.mjs`, because re-running post-build does not move
  that field once the machine exists.

---

## Is it worth it?

For the bounties: no, and Flare said so. For the product: yes, eventually — a
simulated enclave protects against the operator by construction and against
nothing by attestation, and the whole claim of this desk is that nobody can read
a bid. Real attestation is what turns that from a design property into something
a counterparty can verify.

The order that makes sense is: record the video first, submit, then do this.
