import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import { VideoService } from './video.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';

@UseGuards(SupabaseAuthGuard)
@Controller('video')
export class VideoController {
  constructor(private readonly videoService: VideoService) {}

  @Post('create')
  async createRoom(@Req() req: any, @Body() body: any) {
    const { userId, role } = req.user;
    const { caseId } = body;
    return this.videoService.createRoom(userId, role, caseId);
  }

  @Post('request')
  async requestVideo(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    const { caseId } = body;
    return this.videoService.requestVideo(userId, caseId);
  }
}
