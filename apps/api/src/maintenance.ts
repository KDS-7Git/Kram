import { db } from "./db";

export async function integrity() {
  const [owners, crossOwnerSkills, invalidConstraints] = await Promise.all([
    db.user.count({ where: { isOwner: true } }),
    db.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) AS count FROM skill s JOIN profile p ON p.id=s."profileId" WHERE s."userId"<>p."userId"`,
    db.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) AS count FROM pg_constraint WHERE NOT convalidated`,
  ]);
  const checks = {
    singleOwner: owners <= 1,
    skillOwnership: Number(crossOwnerSkills[0]?.count) === 0,
    constraintsValidated: Number(invalidConstraints[0]?.count) === 0,
  };
  return { ok: Object.values(checks).every(Boolean), checks };
}
