import { NextResponse } from 'next/server';
import { clearAuthCookie, withoutAuth } from '@/lib/server/api';

export const POST = withoutAuth(() => clearAuthCookie(NextResponse.json({ data: { ok: true } })));
