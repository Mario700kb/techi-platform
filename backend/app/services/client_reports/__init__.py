"""Enterprise client reports: one builder per report, each returning a
ReportDocument (app/schemas/client_report.py) that the preview API, the PDF
and the CSV renderers all read.

Import `app.services.client_reports.service.build_report` to build one; this
package file stays empty so the catalog can be imported from the schemas
without pulling in the builders.
"""
