import { NextResponse } from 'next/server';
import { getSchedulerStatus } from '../../../../lib/scheduler';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getSchedulerStatus());
}
