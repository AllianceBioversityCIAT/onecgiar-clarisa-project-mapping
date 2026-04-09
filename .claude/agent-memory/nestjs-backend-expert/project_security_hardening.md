---
name: Security Hardening (BE-8.1)
description: Wave 8 security hardening — throttler on auth, input trimming, ClassSerializerInterceptor, Swagger consistency, prod Docker setup
type: project
---

Security hardening wave completed with the following changes:

1. **Rate Limiting**: @nestjs/throttler installed, ThrottlerModule registered in AppModule, ThrottlerGuard + @Throttle applied to AuthController only (10 req/min)
2. **Input Sanitization**: @Transform trim added to string fields in CreateProjectDto (code, name), CallbackDto (code), RejectMappingDto (reason); ValidationPipe now includes transformOptions.enableImplicitConversion
3. **Sensitive Data Protection**: @Exclude() on User.cognitoSub, ClassSerializerInterceptor added globally in main.ts
4. **Swagger Consistency**: @ApiBearerAuth('access-token') added to UsersController and DashboardController; existing controllers updated from @ApiBearerAuth() to @ApiBearerAuth('access-token')
5. **Production Infrastructure**: docker-compose.prod.yml and nginx/nginx.conf created
6. **.env.example**: THROTTLE_TTL and THROTTLE_LIMIT vars documented

**Why:** Final hardening pass before production deployment.
**How to apply:** These patterns (throttling on auth, @Exclude on sensitive fields, consistent Swagger decorators) should be maintained for any new endpoints.
