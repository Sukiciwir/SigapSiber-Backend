import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { SupabaseStrategy } from './supabase.strategy';

@Module({
  imports: [PassportModule.register({ defaultStrategy: 'supabase' })],
  providers: [AuthService, SupabaseStrategy],
  exports: [AuthService, PassportModule],
})
export class AuthModule {}
