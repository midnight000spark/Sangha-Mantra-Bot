type Deployment = { id: string; created_on: string; versions: { version_id: string; percentage: number }[] };

/** A window containing only the current 100% deployment, excluding its partial first second. */
export function deploymentWindow(deployments: Deployment[], versionId: string, now = new Date()) {
  if (!deployments.length || deployments.some(d => !Number.isFinite(Date.parse(d.created_on))))
    throw new Error("Deployment timestamps unavailable");
  const latest = [...deployments].sort((a,b) => Date.parse(b.created_on)-Date.parse(a.created_on))[0]!;
  if (latest.versions.length !== 1 || latest.versions[0]!.version_id !== versionId || latest.versions[0]!.percentage !== 100)
    throw new Error("TEST current deployment differs from the receipt or splits traffic");
  const fromMs = Math.floor(Date.parse(latest.created_on)/1000)*1000 + 1000;
  if (fromMs >= now.getTime()) throw new Error("No complete post-deployment second yet");
  return { deploymentId: latest.id, versionId, from: new Date(fromMs).toISOString(), to: now.toISOString() };
}
