import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class VideoService {
  private readonly logger = new Logger(VideoService.name);
  private dailyApiKey: string;

  constructor(
    private configService: ConfigService,
    private supabaseService: SupabaseService,
  ) {
    this.dailyApiKey = this.configService.get<string>('DAILY_API_KEY') || '';
  }

  async createRoom(userId: string, role: string, caseId: string) {
    if (role !== 'responder' && role !== 'admin') {
      throw new HttpException('Forbidden: Hanya responder atau admin yang bisa membuat room', HttpStatus.FORBIDDEN);
    }

    if (!caseId) {
      throw new HttpException('caseId diperlukan', HttpStatus.BAD_REQUEST);
    }

    const supabase = this.supabaseService.getClient();
    const { data: caseData } = await supabase.from('cases').select('id, status').eq('id', caseId).single();

    if (!caseData) {
      throw new HttpException('Kasus tidak ditemukan', HttpStatus.NOT_FOUND);
    }

    if (!this.dailyApiKey) {
      this.logger.error('DAILY_API_KEY is not set');
      throw new HttpException('Server configuration error', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const roomName = `sigap-${caseId.slice(0, 8).toLowerCase()}-${Date.now()}`;

    const res = await fetch('https://api.daily.co/v1/rooms', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.dailyApiKey}`,
      },
      body: JSON.stringify({
        name: roomName,
        properties: {
          exp: Math.floor(Date.now() / 1000) + 60 * 60 * 2,
          enable_chat: true,
          start_video_off: false,
          start_audio_off: false,
        },
      }),
    });

    if (!res.ok) {
      const errData = await res.text();
      this.logger.error(`Daily.co error: ${errData}`);
      throw new HttpException('Gagal membuat video room', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const dailyData = await res.json();
    const roomUrl = dailyData.url;

    const { error: updateErr } = await supabase.from('cases').update({ video_room_url: roomUrl }).eq('id', caseId);

    if (updateErr) {
      this.logger.error(`DB update error: ${updateErr}`);
      throw new HttpException('Gagal menyimpan URL room ke database', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    await supabase.from('messages').insert({
      case_id: caseId,
      sender_id: userId,
      content: 'Responder memulai sesi Video Call.',
      is_system: true,
    });

    return { url: roomUrl };
  }

  async requestVideo(userId: string, caseId: string) {
    if (!caseId) {
      throw new HttpException('caseId diperlukan', HttpStatus.BAD_REQUEST);
    }

    const supabase = this.supabaseService.getClient();
    const { data: caseData } = await supabase.from('cases').select('id, user_id, status').eq('id', caseId).single();

    if (!caseData) {
      throw new HttpException('Kasus tidak ditemukan', HttpStatus.NOT_FOUND);
    }

    if (caseData.user_id !== userId) {
      throw new HttpException('Forbidden: Bukan pemilik kasus', HttpStatus.FORBIDDEN);
    }

    const { error: updateErr } = await supabase.from('cases').update({ video_requested: true }).eq('id', caseId);

    if (updateErr) {
      this.logger.error(`DB update error: ${updateErr}`);
      throw new HttpException('Gagal me-request video call', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    await supabase.from('messages').insert({
      case_id: caseId,
      sender_id: userId,
      content: 'Korban mengajukan sesi Video Call.',
      is_system: true,
    });

    return { success: true };
  }
}
