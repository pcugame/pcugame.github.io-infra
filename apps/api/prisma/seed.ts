/**
 * DB Seed / 데이터 이전 스크립트
 *
 * 사용법:
 *   # 테스트 데이터 + ADMIN 세션 생성 (기본)
 *   npx tsx prisma/seed.ts
 *
 *   # JSON 파일에서 실제 데이터 임포트
 *   npx tsx prisma/seed.ts --import data.json
 *
 * JSON 파일 형식:
 * {
 *   "years": [
 *     { "year": 2024, "title": "2024 졸업작품전" }
 *   ],
 *   "projects": [
 *     {
 *       "year": 2024,
 *       "title": "게임 제목",
 *       "summary": "한 줄 소개",
 *       "description": "상세 설명",
 *       "youtubeUrl": "https://youtube.com/...",
 *       "status": "PUBLISHED",
 *       "members": [
 *         { "name": "홍길동", "studentId": "20240001" }
 *       ]
 *     }
 *   ]
 * }
 */

import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

if (process.env.NODE_ENV === 'production') {
  console.error('ERROR: seed must not run in production');
  process.exit(1);
}

const prisma = new PrismaClient();

// ── 테스트 ADMIN 유저 + 세션 생성 ─────────────────────

async function seedTestAdmin() {
  const user = await prisma.user.upsert({
    where: { googleSub: 'test-admin-sub' },
    update: {},
    create: {
      googleSub: 'test-admin-sub',
      email: 'admin@test.pcu.ac.kr',
      name: 'Test Admin',
      role: 'ADMIN',
    },
  });
  console.log('User:', user.id, user.email, `(${user.role})`);

  // 기존 세션 삭제 후 랜덤 토큰으로 재생성
  await prisma.authSession.deleteMany({ where: { userId: user.id } });
  const sessionId = randomUUID();
  const session = await prisma.authSession.create({
    data: {
      id: sessionId,
      userId: user.id,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30일
    },
  });
  console.log('Session:', session.id, '(30일 유효)');

  return { user, sessionId };
}

// ── 테스트 데이터 생성 ────────────────────────────────

async function seedTestData(creatorId: string) {
  const year = await prisma.year.upsert({
    where: { year: 2026 },
    update: {},
    create: { year: 2026, title: '2026 졸업작품전', isUploadEnabled: true },
  });

  const existing = await prisma.project.findUnique({
    where: { project_year_slug: { yearId: year.id, slug: 'test-project' } },
  });
  if (existing) {
    console.log('테스트 프로젝트가 이미 존재합니다. 건너뜁니다.');
    return;
  }

  const project = await prisma.project.create({
    data: {
      yearId: year.id,
      slug: 'test-project',
      title: '테스트 졸업작품',
      summary: '배포 검증용 테스트 프로젝트입니다.',
      description: '이것은 시스템이 정상 동작하는지 확인하기 위한 테스트 프로젝트입니다.',
      status: 'PUBLISHED',
      creatorId,
      members: {
        create: [
          { name: '홍길동', studentId: '20260001', sortOrder: 0 },
          { name: '김철수', studentId: '20260002', sortOrder: 1 },
        ],
      },
    },
  });
  console.log('테스트 프로젝트:', project.id, project.title);
}

// ── JSON 파일에서 실제 데이터 임포트 ──────────────────

interface ImportYear {
  year: number;
  title?: string;
  isUploadEnabled?: boolean;
}

interface ImportMember {
  name: string;
  studentId?: string;
  sortOrder?: number;
}

interface ImportProject {
  year: number;
  title: string;
  slug?: string;
  summary?: string;
  description?: string;
  youtubeUrl?: string;
  status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  downloadPolicy?: 'NONE' | 'PUBLIC' | 'SCHOOL_ONLY' | 'ADMIN_ONLY';
  githubUrl?: string;
  platforms?: ('PC' | 'MOBILE' | 'WEB')[];
  members?: ImportMember[];
}

interface ImportData {
  years?: ImportYear[];
  projects?: ImportProject[];
}

function toSlugSimple(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'project';
}

async function importFromJson(filePath: string, creatorId: string) {
  const raw = readFileSync(filePath, 'utf-8');
  const data: ImportData = JSON.parse(raw);

  // 연도 생성
  const yearMap = new Map<number, string>(); // year number -> year id
  if (data.years) {
    for (const y of data.years) {
      const created = await prisma.year.upsert({
        where: { year: y.year },
        update: { title: y.title ?? '', isUploadEnabled: y.isUploadEnabled ?? true },
        create: { year: y.year, title: y.title ?? '', isUploadEnabled: y.isUploadEnabled ?? true },
      });
      yearMap.set(y.year, created.id);
      console.log(`연도: ${y.year} (${created.id})`);
    }
  }

  // 프로젝트 생성
  if (data.projects) {
    let created = 0;
    let skipped = 0;

    for (const p of data.projects) {
      // 연도가 없으면 자동 생성
      if (!yearMap.has(p.year)) {
        const y = await prisma.year.upsert({
          where: { year: p.year },
          update: {},
          create: { year: p.year, isUploadEnabled: true },
        });
        yearMap.set(p.year, y.id);
      }
      const yearId = yearMap.get(p.year)!;

      // slug 생성 (중복 시 번호 추가)
      const baseSlug = p.slug || toSlugSimple(p.title);
      let slug = baseSlug;
      let attempt = 0;
      while (
        await prisma.project.findUnique({
          where: { project_year_slug: { yearId, slug } },
        })
      ) {
        attempt++;
        slug = `${baseSlug}-${attempt}`;
      }

      if (attempt > 0 && !p.slug) {
        // 같은 제목이 이미 있다면 중복일 수 있음
        console.log(`  ⚠ "${p.title}" slug 충돌 → ${slug}`);
      }

      const project = await prisma.project.create({
        data: {
          yearId,
          slug,
          title: p.title,
          summary: p.summary ?? '',
          description: p.description ?? '',
          youtubeUrl: p.youtubeUrl ?? '',
          status: p.status ?? 'PUBLISHED',
          downloadPolicy: p.downloadPolicy ?? 'PUBLIC',
          githubUrl: p.githubUrl ?? '',
          platforms: p.platforms ?? [],
          creatorId,
          members: {
            create: (p.members ?? []).map((m, i) => ({
              name: m.name,
              studentId: m.studentId ?? '',
              sortOrder: m.sortOrder ?? i,
            })),
          },
        },
      });
      created++;
      console.log(`  프로젝트: ${project.title} (${p.year}/${slug})`);
    }

    console.log(`\n임포트 완료: ${created}개 생성, ${skipped}개 건너뜀`);
  }
}

// ── Main ──────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const importIndex = args.indexOf('--import');

  console.log('━━━ PCU Graduation DB Seed ━━━\n');

  // 항상 테스트 ADMIN 생성
  const { user: admin, sessionId } = await seedTestAdmin();
  console.log('');

  if (importIndex !== -1 && args[importIndex + 1]) {
    // JSON 파일에서 데이터 임포트
    const filePath = args[importIndex + 1];
    console.log(`"${filePath}"에서 데이터 임포트 중...\n`);
    await importFromJson(filePath, admin.id);
  } else {
    // 테스트 데이터 생성
    console.log('테스트 데이터 생성 중...\n');
    await seedTestData(admin.id);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`세션 쿠키 값: ${sessionId}`);
  console.log('브라우저 콘솔에서 로그인:');
  console.log(`document.cookie = "sid=${sessionId}; path=/; secure; samesite=none"`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main()
  .catch((e) => {
    console.error('Seed 실패:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
