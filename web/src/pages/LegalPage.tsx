import type { AuthConfigDto } from '@shared/domain';
import { PRODUCT_NAME, VENDOR_NAME } from '@shared/product';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Boxes } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../lib/api';

/**
 * The public privacy notice and terms.
 *
 * Written from what the system actually does rather than from a template: the sections about what
 * is stored and where it goes are the same facts the platform's own governance page states, because
 * a privacy notice that does not match the code is worse than none.
 */

const UPDATED = '29 September 2026';

function Shell({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <div className="min-h-full bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-3">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600">
              <Boxes className="h-4 w-4 text-white" aria-hidden />
            </span>
            <span className="text-sm font-semibold text-slate-900">{PRODUCT_NAME}</span>
          </Link>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">{title}</h1>
        <p className="mt-3 text-slate-600">{lead}</p>
        <p className="mt-2 text-xs text-slate-500">Last updated {UPDATED}</p>
        <div className="mt-10 space-y-8">{children}</div>
        <div className="mt-12 border-t border-slate-200 pt-6 text-sm text-slate-500">
          <Link to={title.startsWith('Privacy') ? '/terms' : '/privacy'} className="text-brand-700">
            {title.startsWith('Privacy') ? 'Terms of use' : 'Privacy notice'}
          </Link>
          <span className="mx-2">·</span>
          <Link to="/" className="text-brand-700">
            Product overview
          </Link>
        </div>
      </main>
    </div>
  );
}

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-slate-900">{heading}</h2>
      <div className="mt-2 space-y-3 text-sm leading-relaxed text-slate-700">{children}</div>
    </section>
  );
}

const Bullets = ({ items }: { items: ReactNode[] }) => (
  <ul className="ml-5 list-disc space-y-1.5">
    {items.map((item, i) => (
      <li key={i}>{item}</li>
    ))}
  </ul>
);

function useContact() {
  const config = useQuery({
    queryKey: ['auth-config'],
    queryFn: () => get<AuthConfigDto>('/api/auth/config'),
  });
  const email = config.data?.contactEmail ?? null;
  return email ? (
    <a href={`mailto:${email}`} className="text-brand-700">
      {email}
    </a>
  ) : (
    <Link to="/#request" className="text-brand-700">
      the request form on our home page
    </Link>
  );
}

export function PrivacyPage() {
  const contact = useContact();
  return (
    <Shell
      title="Privacy notice"
      lead="What this service collects, why, where it goes and how long it is kept. It describes what the software actually does."
    >
      <Section heading="The short version">
        <p>
          We hold the details you give us so we can reply to you and, if you connect a system, the
          configuration and the results of the work you ask the platform to do. Your data is never sent to an
          AI model, never sold, never used for advertising, and never shared with anyone except the systems
          you yourself connect.
        </p>
      </Section>

      <Section heading="If you ask us for access">
        <p>The form on our home page collects:</p>
        <Bullets
          items={[
            'Your name and work email address, so we can reply.',
            'Your company and a description of what you are moving, both optional, so the reply is useful.',
          ]}
        />
        <p>
          We use this only to respond to you and to decide whether we can help. It is not added to a marketing
          list. We keep one record per email address; asking again updates it rather than creating another.
        </p>
      </Section>

      <Section heading="If you sign in">
        <p>
          Sign-in uses Microsoft Entra ID. We receive your name, email address, and the identifiers Microsoft
          issues for you and your organisation. We never see or ask for your password.
        </p>
        <Bullets
          items={[
            'Access tokens stay on our server in an encrypted cache. They are never sent to your browser.',
            'Your session cookie holds only a hash of the session, is marked HttpOnly, and expires server-side.',
            'On a deployment running in demo mode, an optional name you type is stored so your work is distinguishable from other people testing.',
          ]}
        />
      </Section>

      <Section heading="If you connect a system">
        <p>Connecting a source or target means the platform stores, in its own database:</p>
        <Bullets
          items={[
            'The connection settings, and the credential encrypted with AES-GCM in a separate table. A credential is decrypted only to open a connection, is never returned by the API, and is never written to a log.',
            'The table metadata it reads: schemas, columns, keys and relationships.',
            'Analysis profiles: per-column statistics, counts and ranges.',
            'Field values in three specific places: the preflight drill-down, validation differences and comparison differences. Each is capped per table, and columns marked as secured are masked before they are written.',
            'A map of source record identifier to target record identifier, which is what stops a re-run duplicating records.',
            'An audit trail of consequential actions.',
            'Files you upload, and SharePoint lists you import, in full. There is nowhere else to read them back from.',
          ]}
        />
        <p>
          It does <strong>not</strong> keep a copy of the records it migrates. A migration streams from source
          to target; what remains afterwards is the identity map and the counts.
        </p>
      </Section>

      <Section heading="Where data goes">
        <p>
          The server opens outbound connections to four kinds of destination, and nothing else: the systems
          you connect; Microsoft Entra ID for sign-in; the Microsoft Dataverse discovery endpoint; and
          Microsoft Graph, only if reading OneDrive and SharePoint has been switched on for your deployment.
        </p>
        <p>
          There is no analytics service, no error-reporting service, no advertising technology and no
          third-party tracker. Where the operator of a deployment has configured an alerting webhook, a short
          summary of consequential events, including that someone requested access, is posted to the endpoint
          they chose.
        </p>
      </Section>

      <Section heading="Artificial intelligence">
        <p>
          Your data is not sent to any AI model. There is no model provider, no inference endpoint, no
          embedding service and no vector store in the path. The column-mapping suggestions are computed
          inside the deployment from name similarity and type compatibility, with no network call. If that
          ever changes it will be optional, off by default, and stated here before it ships.
        </p>
      </Section>

      <Section heading="Cookies">
        <p>
          One cookie, which keeps you signed in. It is strictly necessary for the service to work, contains no
          personal information, and is not used to track you. We set no analytics or advertising cookies.
        </p>
      </Section>

      <Section heading="How long it is kept">
        <Bullets
          items={[
            'Anything belonging to an object you delete goes with it: delete a connection and its credential, imported rows and metadata are deleted; delete a project and its analyses and comparisons are deleted.',
            'Access requests are kept until we have dealt with them, and deleted on request.',
            'Sessions expire on their own and are removed.',
            'Logs carry request identifiers and are scrubbed of secrets. They are kept only as long as our hosting retains them.',
          ]}
        />
      </Section>

      <Section heading="Your rights">
        <p>
          You can ask us what we hold about you, ask for it to be corrected, or ask for it to be deleted.
          Where a deployment is run by your own organisation, that organisation controls the data in it and
          your request goes to them. Contact us at {contact}.
        </p>
      </Section>

      <Section heading="Self-hosting">
        <p>
          This platform can be run inside your own network, on your own database. In that case none of the
          data described above leaves your estate, and your organisation is the controller of all of it.
        </p>
      </Section>
    </Shell>
  );
}

export function TermsPage() {
  const contact = useContact();
  return (
    <Shell title="Terms of use" lead="The terms on which this service is offered while it is in evaluation.">
      <Section heading="What this is">
        <p>
          The {PRODUCT_NAME}, provided by {VENDOR_NAME}. It is offered for evaluation and pilot use. It is not
          yet a generally available product, and it is provided without a service level commitment.
        </p>
      </Section>

      <Section heading="Using it responsibly">
        <Bullets
          items={[
            'Connect only systems you are authorised to connect, using credentials you are entitled to use.',
            'Do not use the service to access, copy or move data you have no right to.',
            'Do not attempt to reach other customers’ data, or to disrupt the service for others.',
            'Keep your credentials and your sign-in to yourself.',
          ]}
        />
      </Section>

      <Section heading="Your data stays yours">
        <p>
          You keep all rights in the data you connect, upload or produce with the service. We claim no licence
          over it beyond what is needed to operate the service for you. We do not use it to train any model,
          and we do not sell or share it.
        </p>
      </Section>

      <Section heading="What the service does and does not promise">
        <p>
          The platform is built to show you what a migration will do before it does it, and to report what it
          did afterwards. It is not a substitute for your own backups, your own testing, or your own judgement
          about a production change.
        </p>
        <p>
          Some capabilities are deliberately absent, and are listed on our evaluation page rather than left to
          be discovered. In particular the platform does not delete records in a target and cannot undo a
          completed migration.
        </p>
        <p>
          During evaluation the service is provided “as is”, without warranties, and to the extent the law
          allows we are not liable for loss arising from its use. Take a backup before you write to a
          production system.
        </p>
      </Section>

      <Section heading="Availability and changes">
        <p>
          This is a pre-release service. We may change it, take it offline for maintenance, or discontinue a
          deployment. We will give reasonable notice before removing a deployment you are relying on, and
          these terms may be updated. The date above shows when they last were.
        </p>
      </Section>

      <Section heading="Contact">
        <p>Questions about these terms: {contact}.</p>
      </Section>
    </Shell>
  );
}
