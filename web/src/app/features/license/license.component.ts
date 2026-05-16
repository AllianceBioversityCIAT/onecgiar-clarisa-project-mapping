import { ChangeDetectionStrategy, Component } from '@angular/core';
import { HeaderComponent } from '../../layout/header/header.component';
import { FooterComponent } from '../../layout/footer/footer.component';

@Component({
  selector: 'app-license',
  standalone: true,
  imports: [HeaderComponent, FooterComponent],
  templateUrl: './license.component.html',
  styleUrl: './license.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LicenseComponent {}
