import { Controller, Post, Get, Body, Query, Req, UseGuards } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';

@Controller('payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @UseGuards(SupabaseAuthGuard)
  @Post('create')
  async createPayment(@Req() req: any, @Body() body: any) {
    // req.user comes from SupabaseAuthGuard validate() method
    const { userId, email } = req.user;
    const { caseId, amount, incidentType, description } = body;
    
    return this.paymentService.createPayment(userId, email, caseId, amount, incidentType, description);
  }

  // Not guarded because verify might be called without strict auth, or we can guard it.
  // We'll guard it for security.
  @UseGuards(SupabaseAuthGuard)
  @Get('verify')
  async verifyPayment(@Query('caseId') caseId: string) {
    return this.paymentService.verifyPayment(caseId);
  }

  // Webhook from Midtrans, NO GUARD
  @Post('notification')
  async handleNotification(@Body() body: any) {
    return this.paymentService.handleNotification(body);
  }
}
