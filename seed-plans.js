/**
 * Seed subscription plans.
 * Run once: node seed-plans.js
 */
const prisma = require('./src/config/database');

const PLANS = [
  {
    name: 'Starter',
    price: 20000,
    duration_days: 30,
    features: JSON.stringify({ manager_slots: 1, pos_slots: 1 }),
  },
  {
    name: 'Standard',
    price: 60000,
    duration_days: 30,
    features: JSON.stringify({ manager_slots: 1, pos_slots: 2 }),
  },
  {
    name: 'Professional',
    price: 100000,
    duration_days: 30,
    features: JSON.stringify({ manager_slots: 2, pos_slots: 3 }),
  },
  {
    name: 'Enterprise',
    price: 200000,
    duration_days: 30,
    features: JSON.stringify({ manager_slots: 3, pos_slots: 5 }),
  },
];

async function main() {
  for (const plan of PLANS) {
    const existing = await prisma.subscriptionPlan.findUnique({ where: { name: plan.name } });
    if (existing) {
      await prisma.subscriptionPlan.update({ where: { name: plan.name }, data: plan });
      console.log(`Updated: ${plan.name} — KES ${plan.price.toLocaleString()}/mo`);
    } else {
      await prisma.subscriptionPlan.create({ data: plan });
      console.log(`Created: ${plan.name} — KES ${plan.price.toLocaleString()}/mo`);
    }
  }
  console.log('\nDone. Plans:');
  const all = await prisma.subscriptionPlan.findMany({ where: { is_active: true }, orderBy: { price: 'asc' } });
  all.forEach(p => {
    const f = JSON.parse(p.features || '{}');
    console.log(`  ${p.name.padEnd(14)} KES ${String(p.price).padEnd(8)} | ${f.manager_slots} manager, ${f.pos_slots} POS`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
