import { PrismaClient, CategoryType } from '@prisma/client';

const prisma = new PrismaClient();

const CATEGORIES: { type: CategoryType; name: string; icon: string; color: string }[] = [
  { type: 'housing',       name: 'Vivienda',         icon: '🏠', color: '#7C9EFF' },
  { type: 'utilities',     name: 'Servicios básicos', icon: '⚡', color: '#FFD166' },
  { type: 'savings',       name: 'Ahorros',           icon: '💎', color: '#C9F131' },
  { type: 'unexpected',    name: 'Imprevistos',       icon: '🛡️', color: '#FF7B7B' },
  { type: 'personal',      name: 'Ocio y personal',   icon: '✨', color: '#B4A7FF' },
  { type: 'investments',   name: 'Inversiones',       icon: '📈', color: '#4DFFB4' },
  { type: 'subscriptions', name: 'Suscripciones',     icon: '📱', color: '#FF9F4A' },
];

async function main() {
  console.log('Seeding global categories…');

  for (const cat of CATEGORIES) {
    await prisma.category.upsert({
      where: { type: cat.type },
      update: { name: cat.name, icon: cat.icon, color: cat.color },
      create: cat,
    });
  }

  console.log(`Done — ${CATEGORIES.length} categories upserted.`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
