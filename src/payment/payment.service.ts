import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private isSandbox: boolean;
  private midtransServerKey: string;
  private midtransClientKey: string;
  private midtransSnapUrl: string;
  private midtransApiUrl: string;
  private isDevBypass: boolean;

  constructor(
    private configService: ConfigService,
    private supabaseService: SupabaseService,
  ) {
    this.midtransServerKey = this.configService.get<string>('MIDTRANS_SERVER_KEY') ?? '';
    this.midtransClientKey = this.configService.get<string>('NEXT_PUBLIC_MIDTRANS_CLIENT_KEY') ?? '';
    
    this.isSandbox = this.configService.get<string>('NEXT_PUBLIC_MIDTRANS_IS_SANDBOX') === 'true' || 
                     this.midtransServerKey.startsWith('SB-');
                     
    this.midtransSnapUrl = this.isSandbox
      ? 'https://app.sandbox.midtrans.com/snap/v1/transactions'
      : 'https://app.midtrans.com/snap/v1/transactions';
      
    this.midtransApiUrl = this.isSandbox
      ? 'https://api.sandbox.midtrans.com/v2'
      : 'https://api.midtrans.com/v2';
      
    this.isDevBypass = !this.midtransServerKey || this.midtransServerKey.includes('xxxx') ||
                       !this.midtransClientKey || this.midtransClientKey.includes('xxxx') ||
                       this.midtransServerKey.startsWith('Mid-client-');
                       
    this.logger.log(`Mode: ${this.isSandbox ? 'SANDBOX' : 'PRODUCTION'} | Bypass: ${this.isDevBypass}`);
  }

  async createPayment(userId: string, email: string, caseId: string, amount: number, incidentType: string, description: string) {
    const supabase = this.supabaseService.getClient();

    if (this.isDevBypass) {
      this.logger.log(`[payment/create] DEV BYPASS aktif — skip Midtrans, langsung open case`);
      const orderId = `DEV-${caseId.slice(0, 8).toUpperCase()}-${Date.now()}`;

      await supabase.from('cases').update({
        payment_id: orderId,
        payment_status: 'paid',
        payment_amount: amount,
        status: 'open',
      }).eq('id', caseId).eq('user_id', userId);

      await supabase.from('messages').insert({
        case_id: caseId,
        content: '✅ [Mode Development] Sesi First Aid aktif. Responder akan bergabung sebentar.',
        is_system: true,
      });

      return { token: null, redirectUrl: null, orderId, devBypass: true };
    }

    const { data: profile } = await supabase.from('profiles').select('full_name, phone').eq('id', userId).single();

    const orderId = `SIGAP-${caseId.slice(0, 8).toUpperCase()}-${Date.now()}`;
    const firstName = profile?.full_name?.split(' ')[0] ?? 'Pengguna';
    const lastName = profile?.full_name?.split(' ').slice(1).join(' ') ?? '';
    const appUrl = this.configService.get<string>('NEXT_PUBLIC_APP_URL') ?? 'http://localhost:3000';

    const snapPayload = {
      transaction_details: { order_id: orderId, gross_amount: amount },
      item_details: [{
        id: 'TIER1-FIRSTAID',
        price: amount,
        quantity: 1,
        name: `First Aid Siber — ${incidentType.replace(/-/g, ' ')}`,
        brand: 'SigapSiber',
        category: 'Cybersecurity Service',
      }],
      customer_details: {
        first_name: firstName,
        last_name: lastName,
        email: email ?? '',
        phone: profile?.phone ?? '',
      },
      callbacks: {
        finish: `${appUrl}/bantuan/${caseId}?payment=success`,
        error: `${appUrl}/bantuan/${caseId}?payment=error`,
        pending: `${appUrl}/bantuan/${caseId}?payment=pending`,
      },
      expiry: { unit: 'hours', duration: 2 },
    };

    const b64Key = Buffer.from(`${this.midtransServerKey}:`).toString('base64');
    let mtRes: Response;
    try {
      mtRes = await fetch(this.midtransSnapUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${b64Key}` },
        body: JSON.stringify(snapPayload),
      });
    } catch (fetchErr) {
      throw new HttpException('Tidak bisa terhubung ke payment gateway.', HttpStatus.BAD_GATEWAY);
    }

    if (!mtRes.ok) {
      const errText = await mtRes.text();
      let mtErrMsg = `Midtrans error ${mtRes.status}`;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error_messages?.length) mtErrMsg = parsed.error_messages.join(', ');
      } catch (e) {}
      throw new HttpException(mtErrMsg, HttpStatus.BAD_GATEWAY);
    }

    const mtData = await mtRes.json();
    if (!mtData.token) {
      throw new HttpException('Midtrans tidak mengembalikan token.', HttpStatus.BAD_GATEWAY);
    }

    // Save token to case. Safe because we use SERVICE_ROLE_KEY
    await supabase.from('cases').update({
      payment_id: orderId,
      payment_token: mtData.token,
      payment_status: 'pending',
      payment_amount: amount,
      status: 'pending_payment',
    }).eq('id', caseId).eq('user_id', userId);

    return { token: mtData.token, redirectUrl: mtData.redirect_url, orderId, devBypass: false };
  }

  async verifyPayment(caseId: string) {
    const supabase = this.supabaseService.getClient();

    const { data: caseData } = await supabase.from('cases').select('payment_id, payment_status, status').eq('id', caseId).single();

    if (!caseData || !caseData.payment_id) {
      throw new HttpException('Case not found or no payment_id', HttpStatus.NOT_FOUND);
    }

    if (caseData.payment_status === 'paid') {
      return { status: 'already_paid' };
    }

    const b64Key = Buffer.from(`${this.midtransServerKey}:`).toString('base64');
    const mtRes = await fetch(`${this.midtransApiUrl}/${caseData.payment_id}/status`, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Basic ${b64Key}` }
    });

    if (!mtRes.ok) {
      // Sometimes Midtrans returns 404 for newly created transactions. We return pending.
      if (mtRes.status === 404) return { status: 'pending' };
      throw new HttpException('Failed to check Midtrans status', mtRes.status);
    }

    const mtData = await mtRes.json();
    const transactionStatus = mtData.transaction_status;
    const fraudStatus = mtData.fraud_status;

    let paymentStatus = 'pending';
    let newCaseStatus = 'pending_payment';
    let isSuccess = false;

    if (transactionStatus === 'capture' || transactionStatus === 'settlement') {
      paymentStatus = (transactionStatus === 'capture' && fraudStatus === 'challenge') ? 'pending' : 'paid';
      newCaseStatus = (transactionStatus === 'capture' && fraudStatus === 'challenge') ? 'pending_payment' : 'open';
      isSuccess = paymentStatus === 'paid';
    } else if (['cancel', 'deny', 'expire'].includes(transactionStatus)) {
      paymentStatus = 'failed';
      newCaseStatus = 'closed'; // or keep it open for retry?
    }

    if (paymentStatus !== caseData.payment_status) {
      // Use RPC to bypass RLS, or directly update since backend uses Service Role
      await supabase.from('cases').update({
        payment_status: paymentStatus,
        status: newCaseStatus,
        updated_at: new Date().toISOString(),
      }).eq('id', caseId);

      if (isSuccess) {
        await supabase.from('messages').insert({
          case_id: caseId,
          content: '✅ Pembayaran dikonfirmasi. Sesi First Aid siber kamu sudah aktif. Seorang responder akan bergabung sebentar lagi.',
          is_system: true,
        });
      }
    }

    return { status: paymentStatus, transaction_status: transactionStatus };
  }

  async handleNotification(body: any) {
    const supabase = this.supabaseService.getClient();
    const order_id = body.order_id;
    const transaction_status = body.transaction_status;
    const fraud_status = body.fraud_status;

    if (!order_id) {
      throw new HttpException('Missing order_id', HttpStatus.BAD_REQUEST);
    }

    let paymentStatus = 'pending';
    let caseStatus = 'pending_payment';

    if (transaction_status === 'capture' || transaction_status === 'settlement') {
      paymentStatus = (transaction_status === 'capture' && fraud_status === 'challenge') ? 'pending' : 'paid';
      caseStatus = (transaction_status === 'capture' && fraud_status === 'challenge') ? 'pending_payment' : 'open';
    } else if (['cancel', 'deny', 'expire'].includes(transaction_status)) {
      paymentStatus = 'failed';
    } else if (transaction_status === 'pending') {
      paymentStatus = 'pending';
    }

    // Since we use Service Role Key, we don't need RPC! But we can just use normal update
    const { error, data } = await supabase.from('cases').update({
      payment_status: paymentStatus,
      status: caseStatus,
      updated_at: new Date().toISOString(),
    }).eq('payment_id', order_id).select('id, payment_status').single();

    if (error) {
      this.logger.error('Notification update error:', error);
      throw new HttpException('DB update failed', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    if (paymentStatus === 'paid' && data) {
      const { data: existingMsg } = await supabase.from('messages').select('id')
        .eq('case_id', data.id)
        .eq('is_system', true)
        .like('content', '%Pembayaran dikonfirmasi%')
        .single();
        
      if (!existingMsg) {
        await supabase.from('messages').insert({
          case_id: data.id,
          content: '✅ Pembayaran dikonfirmasi. Sesi First Aid siber kamu sudah aktif. Seorang responder akan bergabung sebentar lagi.',
          is_system: true,
        });
      }
    }

    return { status: 'ok' };
  }
}
